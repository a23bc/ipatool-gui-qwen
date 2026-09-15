/**
 * High-level ipatool operations.
 *
 * Each method maps to one ipatool sub-command, runs it as a tracked task, parses
 * zerolog's JSON output into a typed result, and translates failures into a
 * stable error code the renderer can localise.
 *
 * Two behaviours deserve emphasis:
 *
 * - **`download` runs *without* `--non-interactive`.** progressbar is only
 *   constructed in interactive mode, and it does not require a TTY to render, so
 *   we keep interactivity purely to get progress. Every value ipatool might
 *   otherwise prompt for (passphrase) is supplied as a flag, and stdin is
 *   closed, so the process can never block.
 *
 * - **2FA is a two-step login, not an interactive prompt.** In non-interactive
 *   mode ipatool *exits 0* and logs "2FA code is required…". We detect that and
 *   re-run with `--auth-code`, which keeps the whole flow inside the GUI.
 */

import type {
  AccountInfo,
  DownloadOutcome,
  LoginResult,
  Platform,
  PurchaseOutcome,
  PurchasesResult,
  SearchResult,
  StoreApp,
  TaskKind,
  VersionMetadata,
  VersionsResult
} from '../shared/types'
import {
  accountInfoArgs,
  downloadArgs,
  listPurchasesArgs,
  listVersionsArgs,
  loginArgs,
  purchaseArgs,
  revokeArgs,
  searchArgs,
  versionMetadataArgs,
  withGlobals,
  type AppSelector
} from '../shared/ipatool/args'
import {
  buildOutcome,
  isJsonLine,
  parseJsonLine,
  parseProgressChunk,
  readApps,
  readNumber,
  readString,
  readStringArray,
  type CommandOutcome,
  type ProgressSample,
  type ZerologEvent
} from '../shared/ipatool/parse'
import { classifyError, shorten, type IpatoolErrorCode } from '../shared/ipatool/errors'
import { engineManager } from './engine'
import * as profiles from './profiles'
import { settingsStore } from './settings'
import { taskRegistry } from './tasks'
import { startProcess, type RunOutcome, type StreamName } from './runner'

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: IpatoolErrorCode,
    readonly taskId: string,
    readonly exitCode: number | null,
    readonly retryable = false,
    readonly actionable = false
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

interface ExecuteOptions {
  kind: TaskKind
  label: string
  args: string[]
  /** Profile to run as; defaults to the active one. */
  profileId?: string
  /** Extra values to scrub from logs (the global passphrase is added automatically). */
  secrets?: string[]
  /** Keep ipatool interactive so it renders its progress bar. */
  interactive?: boolean
  cwd?: string
  timeoutMs?: number
  /** Raw stream chunks, used by `download` for progress parsing. */
  onChunk?: (text: string, stream: StreamName) => void
  onProgress?: (sample: ProgressSample) => void
  /**
   * Reports the task id the moment it is allocated, so a caller (the download
   * queue) can cancel the process before the promise settles.
   */
  onTask?: (taskId: string) => void
}

interface ExecuteResult {
  outcome: CommandOutcome
  run: RunOutcome
  taskId: string
}

/** Coerces zerolog's loosely-typed app objects into our StoreApp shape. */
export function normalizeApp(raw: unknown): StoreApp | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const id = Number(obj.id ?? obj.trackId ?? 0)
  const bundleID = String(obj.bundleID ?? obj.bundleId ?? '')
  const name = String(obj.name ?? obj.trackName ?? '')
  if (!Number.isFinite(id) || id === 0) {
    if (!bundleID && !name) return null
  }
  const price = Number(obj.price ?? 0)
  const platforms = Array.isArray(obj.platforms) ? obj.platforms.map(String) : undefined
  const purchaseDate =
    typeof obj.purchaseDate === 'string' && obj.purchaseDate !== '' ? obj.purchaseDate : undefined

  return {
    id: Number.isFinite(id) ? id : 0,
    bundleID,
    name,
    version: String(obj.version ?? ''),
    price: Number.isFinite(price) ? price : 0,
    ...(platforms ? { platforms } : {}),
    ...(purchaseDate ? { purchaseDate } : {})
  }
}

function normalizeApps(event: ZerologEvent | null): StoreApp[] {
  return readApps(event)
    .map(normalizeApp)
    .filter((app): app is StoreApp => app !== null)
}

/** Collects every secret that must never appear in a log line. */
function secretList(extra: string[] = []): string[] {
  const settings = settingsStore.getInternal()
  const secrets = [settings.keychainPassphrase, ...extra].filter((s) => typeof s === 'string' && s.length > 0)
  return Array.from(new Set(secrets))
}

export class IpatoolApi {
  /** Runs one ipatool invocation end-to-end and returns its parsed output. */
  private async execute(options: ExecuteOptions): Promise<ExecuteResult> {
    const binary = await engineManager.ensure()
    const settings = settingsStore.getInternal()
    const passphrase = await settingsStore.effectivePassphrase()

    // Session isolation: every invocation runs against one profile's state dir.
    // An explicit profileId is authoritative; the fallback is the synchronous
    // in-memory active mirror, never a re-read of persisted settings.
    const profile =
      (options.profileId ? profiles.get(options.profileId) : null) ?? profiles.active()
    profiles.touch(profile.id)

    // Guard against silently acting as the wrong account: if this profile's
    // session was previously observed to belong to a different e-mail than the
    // profile records, refuse and ask for a re-login.
    if (options.kind !== 'login' && options.kind !== 'account') {
      const observed = profiles.recordedSessionEmail(profile.id)
      if (observed && profile.email && observed.toLowerCase() !== profile.email.toLowerCase()) {
        throw new ApiError(
          `Session mismatch for ${profile.name}: stored ${profile.email}, session ${observed}`,
          'session-mismatch',
          'guard',
          null,
          false,
          true
        )
      }
    }
    const profileEnv = profiles.envFor(profile)
    await profiles.ensureDir(profile)

    const args = withGlobals(options.args, {
      format: 'json',
      verbose: settings.verbose,
      nonInteractive: !options.interactive,
      keychainPassphrase: passphrase || undefined
    })

    const secrets = secretList(options.secrets ?? [])
    const handle = taskRegistry.create(options.kind, options.label, args, secrets)
    const taskId = handle.record.id
    options.onTask?.(taskId)

    const events: ZerologEvent[] = []
    const textLines: string[] = []

    taskRegistry.system(taskId, `exec: ${handle.record.command}`, 'debug')
    taskRegistry.system(
      taskId,
      `profile: ${profile.name}${profile.email ? ` <${profile.email}>` : ''} @ ${profiles.dirFor(profile)}`,
      'debug'
    )

    const running = startProcess(binary, {
      args,
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
      secrets,
      env: engineManager.childEnv(profileEnv),
      onLine: (line, stream, progress) => {
        if (progress) {
          // Progress renders are collapsed by the renderer's log store; keeping
          // them out of `textLines` also stops them polluting error messages.
          taskRegistry.log(taskId, { stream, level: 'progress', text: line })
          return
        }
        const event = parseJsonLine(line)
        if (event) {
          events.push(event)
          const level =
            event.level === 'error'
              ? 'error'
              : event.level === 'warn'
                ? 'warn'
                : event.level === 'debug'
                  ? 'debug'
                  : 'info'
          taskRegistry.log(taskId, { stream, level, text: line })
        } else {
          textLines.push(line)
          taskRegistry.log(taskId, { stream, level: stream === 'stderr' ? 'warn' : 'info', text: line })
        }
      },
      onChunk: (text, stream) => {
        options.onChunk?.(text, stream)
        // Progress renders and zerolog events share stdout; a JSON line must
        // never reach the numeric progress parser.
        if (options.onProgress && stream === 'stdout' && !isJsonLine(text.trimStart())) {
          const sample = parseProgressChunk(text)
          if (sample) options.onProgress(sample)
        }
      }
    })

    taskRegistry.registerCanceller(taskId, () => running.kill())

    const run = await running.promise
    const outcome = buildOutcome(events, textLines)

    const state = run.killed ? 'canceled' : run.code === 0 && !outcome.errorEvent ? 'succeeded' : 'failed'
    taskRegistry.finish(taskId, state, run.code)

    if (run.timedOut) {
      throw new ApiError('ipatool timed out', 'timeout', taskId, run.code, true)
    }

    return { outcome, run, taskId }
  }

  /**
   * Throws ApiError when the invocation failed, otherwise returns the event
   * carrying the payload.
   *
   * Success is decided by exit code + absence of an error event, NOT by a
   * `success: true` field: upstream `search` and `list-purchases` never stamp
   * one, so relying on it turned successful searches into errors.
   */
  private assertSuccess(result: ExecuteResult, context: string): ZerologEvent {
    const { outcome, run, taskId } = result
    const failed = run.code !== 0 || outcome.errorEvent !== null
    if (!failed) return outcome.successEvent ?? outcome.lastInfoEvent ?? {}

    // NOTE: run.stdout/run.stderr are strings; they must be array elements,
    // not spread (spreading a string yields its characters).
    const errorText = outcome.errorEvent?.error
      ? String(outcome.errorEvent.error)
      : [run.stderr, run.stdout, ...outcome.textLines].filter((part) => part && part.trim() !== '').join('\n')

    const classified = classifyError(errorText || `ipatool exited with code ${run.code}`)
    throw new ApiError(
      shorten(classified.message, 600) || context,
      classified.code,
      taskId,
      run.code,
      classified.retryable,
      classified.actionable
    )
  }

  /* ---------------------------------------------------------------- *
   * auth
   * ---------------------------------------------------------------- */

  /**
   * Logs in. Returns a discriminated result rather than throwing, because
   * "2FA required" is a normal, recoverable state that the UI must render as a
   * second input step.
   */
  async login(
    email: string,
    password: string,
    authCode?: string,
    profileId?: string
  ): Promise<LoginResult> {
    const args = loginArgs(email, password, authCode)
    const target = profiles.get(profileId ?? '') ?? profiles.active()
    let result: ExecuteResult
    try {
      result = await this.execute({
        kind: 'login',
        profileId: target.id,
        label: authCode ? 'Login (2FA)' : 'Login',
        args,
        secrets: [password, authCode ?? ''],
        timeoutMs: 180_000
      })
    } catch (error) {
      if (error instanceof ApiError) {
        return {
          status: this.loginStatusFromCode(error.code),
          account: null,
          message: error.message,
          taskId: error.taskId
        }
      }
      throw error
    }

    const { outcome, run, taskId } = result
    const allText = [...outcome.textLines, run.stdout, run.stderr].join('\n')

    // Non-interactive login reports a missing 2FA code as an *info* log and
    // exits 0, so this has to be checked before the generic error path.
    const classified = classifyError(allText, outcome.errorEvent?.error)
    if (classified.code === 'two-factor-required') {
      return {
        status: 'needs-2fa',
        account: null,
        message: 'Apple requires a two-factor code for this account.',
        taskId
      }
    }

    const success = outcome.successEvent
    if (success) {
      const account: AccountInfo = {
        name: readString(success, 'name'),
        email: readString(success, 'email') || email
      }
      profiles.setInfo(target.id, account.email, account.name)
      profiles.noteSessionEmail(target.id, account.email)
      return { status: 'ok', account, message: '', taskId }
    }

    if (outcome.errorEvent) {
      return {
        status: this.loginStatusFromCode(classified.code),
        account: null,
        message: shorten(classified.message, 400),
        taskId
      }
    }

    return {
      status: 'error',
      account: null,
      message: shorten(allText.trim() || `ipatool exited with code ${run.code}`, 400),
      taskId
    }
  }

  private loginStatusFromCode(code: IpatoolErrorCode): LoginResult['status'] {
    switch (code) {
      case 'two-factor-required':
        return 'needs-2fa'
      case 'passphrase-required':
        return 'passphrase-required'
      case 'bad-credentials':
      case 'account-locked':
        return 'bad-credentials'
      case 'rate-limited':
        return 'rate-limited'
      default:
        return 'error'
    }
  }

  async accountInfo(profileId?: string): Promise<AccountInfo> {
    const result = await this.execute({
      kind: 'account',
      label: 'Account info',
      profileId,
      args: accountInfoArgs(),
      timeoutMs: 60_000
    })
    const success = this.assertSuccess(result, 'Could not read account info')
    return { name: readString(success, 'name'), email: readString(success, 'email') }
  }

  /** Returns null instead of throwing when the user is simply not signed in. */
  async accountInfoOrNull(profileId?: string): Promise<AccountInfo | null> {
    try {
      const info = await this.accountInfo(profileId)
      const target = profiles.get(profileId ?? '') ?? profiles.active()
      profiles.setInfo(target.id, info.email, info.name)
      profiles.noteSessionEmail(target.id, info.email)
      return info
    } catch {
      profiles.noteSessionEmail(
        (profiles.get(profileId ?? '') ?? profiles.active()).id,
        null
      )
      return null
    }
  }

  async revoke(): Promise<{ revoked: boolean }> {
    const result = await this.execute({ kind: 'revoke', label: 'Revoke credentials', args: revokeArgs(), timeoutMs: 60_000 })
    this.assertSuccess(result, 'Could not revoke credentials')
    return { revoked: true }
  }

  /* ---------------------------------------------------------------- *
   * catalogue
   * ---------------------------------------------------------------- */

  async search(term: string, limit?: number, platform?: Platform): Promise<SearchResult> {
    const settings = settingsStore.getInternal()
    const result = await this.execute({
      kind: 'search',
      label: `Search "${term}"`,
      args: searchArgs(term, {
        limit: limit ?? settings.searchLimit,
        platform: platform ?? settings.defaultPlatform
      }),
      timeoutMs: 90_000
    })
    const success = this.assertSuccess(result, 'Search failed')
    return {
      count: readNumber(success, 'count') ?? normalizeApps(success).length,
      apps: normalizeApps(success)
    }
  }

  async listVersions(selector: AppSelector, platform?: Platform): Promise<VersionsResult> {
    const result = await this.execute({
      kind: 'versions',
      label: 'List versions',
      args: listVersionsArgs({ ...selector, platform: platform ?? settingsStore.getInternal().defaultPlatform }),
      timeoutMs: 90_000
    })
    const success = this.assertSuccess(result, 'Could not list versions')
    return {
      bundleID: readString(success, 'bundleID'),
      externalVersionIdentifiers: readStringArray(success, 'externalVersionIdentifiers'),
      latestExternalVersionID: readString(success, 'latestExternalVersionID') || undefined
    }
  }

  async getVersionMetadata(
    selector: AppSelector,
    externalVersionID: string,
    platform?: Platform
  ): Promise<VersionMetadata> {
    const result = await this.execute({
      kind: 'metadata',
      label: `Version metadata ${externalVersionID}`,
      args: versionMetadataArgs({
        ...selector,
        externalVersionID,
        platform: platform ?? settingsStore.getInternal().defaultPlatform
      }),
      timeoutMs: 90_000
    })
    const success = this.assertSuccess(result, 'Could not read version metadata')
    return {
      externalVersionID: readString(success, 'externalVersionID') || externalVersionID,
      displayVersion: readString(success, 'displayVersion'),
      releaseDate: readString(success, 'releaseDate') || undefined
    }
  }

  async listPurchases(page = 1, maxResults?: number, platform?: Platform): Promise<PurchasesResult> {
    const settings = settingsStore.getInternal()
    const result = await this.execute({
      kind: 'purchases',
      label: `Purchases (page ${page})`,
      args: listPurchasesArgs({
        page,
        maxResults: maxResults ?? settings.purchasesPageSize,
        platform: platform ?? settings.defaultPlatform
      }),
      timeoutMs: 120_000
    })
    const success = this.assertSuccess(result, 'Could not list purchases')
    const apps = normalizeApps(success)
    return {
      count: readNumber(success, 'count') ?? apps.length,
      totalCount: readNumber(success, 'totalCount') ?? apps.length,
      page: readNumber(success, 'page') ?? page,
      apps
    }
  }

  async purchase(selector: AppSelector, platform?: Platform): Promise<PurchaseOutcome> {
    const result = await this.execute({
      kind: 'purchase',
      label: 'Obtain licence',
      args: purchaseArgs({ ...selector, platform: platform ?? settingsStore.getInternal().defaultPlatform }),
      timeoutMs: 90_000
    })
    const success = this.assertSuccess(result, 'Could not obtain a licence')
    return { alreadyOwned: success.alreadyOwned === true }
  }

  /* ---------------------------------------------------------------- *
   * download
   * ---------------------------------------------------------------- */

  /**
   * Runs a download. Kept interactive so the progress bar renders; progress is
   * surfaced through `onProgress`.
   */
  async download(
    options: {
      profileId?: string
      selector: AppSelector
      output: string
      externalVersionID?: string
      platform?: Platform
      purchase?: boolean
    },
    onProgress: (sample: ProgressSample) => void,
    onTask?: (taskId: string) => void
  ): Promise<DownloadOutcome> {
    const result = await this.execute({
      kind: 'download',
      label: 'Download',
      profileId: options.profileId,
      interactive: true,
      cwd: options.output || undefined,
      args: downloadArgs({
        ...options.selector,
        output: options.output,
        externalVersionID: options.externalVersionID,
        platform: options.platform,
        purchase: options.purchase
      }),
      onProgress,
      onTask,
      timeoutMs: 0
    })

    const success = this.assertSuccess(result, 'Download failed')
    return {
      output: readString(success, 'output'),
      purchased: success.purchased === true
    }
  }

  /** Raw passthrough for the power-user console. */
  async runRaw(args: string[], interactive = false): Promise<string> {
    const result = await this.execute({
      kind: 'raw',
      label: `ipatool ${args[0] ?? ''}`.trim(),
      args,
      interactive,
      timeoutMs: 0
    })
    const { run } = result
    return [run.stdout, run.stderr].filter((s) => s.trim() !== '').join('\n--- stderr ---\n')
  }

  cancelTask(taskId: string): void {
    taskRegistry.cancel(taskId)
  }
}

export const ipatoolApi = new IpatoolApi()
