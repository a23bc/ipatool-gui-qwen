/**
 * IPC wiring.
 *
 * Every handler is `invoke`-based (request/response) except the high-frequency
 * push events, which are throttled in the emitters themselves. Failures are
 * returned as structured `Operation` values rather than thrown, so the renderer
 * always receives a code it can localise instead of a stringified stack.
 */

import { BrowserWindow, clipboard, dialog, ipcMain, shell, nativeTheme, app, Notification } from 'electron'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type {
  AccountInfo,
  AppInfoPayload,
  DownloadRequest,
  EngineStatus,
  Operation,
  OperationFailure,
  QueueItem,
  RawRunRequest,
  Settings
} from '../shared/types'
import type { ProfileView, QueueAction } from '../shared/ipc'
import { IPC } from '../shared/ipc'
import { quoteCommand } from '../shared/format'
import { redactArgs } from '../shared/redact'
import { parseImportList } from '../shared/import'
import { notificationBody } from '../shared/notifications'
import { expandUserPath } from './paths'
import { ApiError, ipatoolApi } from './api'
import { artworkCache } from './artwork'
import { downloadQueue } from './queue'
import { engineManager, EngineError } from './engine'
import * as profiles from './profiles'
import { migrateLegacyState } from './profiles'
import * as credentials from './credentials'
import { settingsStore } from './settings'
import { taskRegistry } from './tasks'
import { APP_PRODUCT, APP_VERSION, checkAppUpdate } from './update'
import { syncTitleBarOverlay } from './window'

export function broadcast<T>(channel: string, payload: T): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

function failure(error: unknown, taskId = ''): OperationFailure {
  if (error instanceof ApiError) {
    return {
      ok: false,
      error: error.message,
      hint: error.code,
      code: error.code,
      taskId: error.taskId || taskId,
      exitCode: error.exitCode
    }
  }
  if (error instanceof EngineError) {
    return { ok: false, error: error.message, hint: error.code, code: error.code, taskId, exitCode: null }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { ok: false, error: message, hint: null, code: 'internal', taskId, exitCode: null }
}

function ok<T>(data: T, taskId = ''): Operation<T> {
  return { ok: true, data, taskId }
}

/** Wraps a handler so thrown errors become structured failures. */
function wrap<T>(fn: () => Promise<T>): Promise<Operation<T>> {
  return fn().then(
    (data) => ok(data),
    (error) => failure(error)
  )
}

/** File extensions the renderer may ask `shell.openPath` about. */
const OPENABLE_FILE = /\.(ipa|pkg|txt|log)$/i

/** True when `resolved` is `root` itself or lives inside it. */
function isInsideRoot(resolved: string, root: string): boolean {
  return resolved === root || resolved.startsWith(root + path.sep)
}

/**
 * Runtime mirror of the shared `QueueAction` union, validated on the main side
 * because IPC payloads are untyped at runtime.
 */
const QUEUE_ACTIONS: ReadonlySet<string> = new Set<QueueAction>([
  'pause',
  'resume',
  'cancel',
  'retry',
  'remove',
  'move-up',
  'move-down',
  'open',
  'reveal',
  'copy-path'
])

/** Read-only ipatool subcommands the raw console may run (see IPC.RunRaw). */
const RAW_ALLOWED_SUBCOMMANDS = new Set(['search', 'list-versions', 'list-purchases', 'get-version-metadata'])
const RAW_ALLOWED_AUTH_SUBCOMMANDS = new Set(['info'])

function rawFailure(message: string): OperationFailure {
  return { ok: false, error: message, hint: null, code: 'bad-request', taskId: '', exitCode: null }
}

function mainWindow(): BrowserWindow | null {
  const windows = BrowserWindow.getAllWindows()
  return windows[0] ?? null
}

function appInfo(): AppInfoPayload {
  return {
    appVersion: APP_VERSION,
    electronVersion: process.versions.electron ?? '',
    chromeVersion: process.versions.chrome ?? '',
    nodeVersion: process.versions.node ?? '',
    platform: process.platform as AppInfoPayload['platform'],
    arch: process.arch,
    locale: app.getLocale(),
    isDev: Boolean(process.env.IPATOOL_GUI_DEV_URL),
    paths: {
      userData: app.getPath('userData'),
      downloads: app.getPath('downloads'),
      documents: app.getPath('documents')
    }
  }
}

let cachedAccount: { name: string; email: string } | null = null

function setAccount(account: { name: string; email: string } | null): void {
  cachedAccount = account
  broadcast('account:changed', account)
}

export function registerIpc(): void {
  /* ---------------------------------------------------------------- *
   * meta
   * ---------------------------------------------------------------- */

  ipcMain.handle(IPC.AppInfo, () => appInfo())

  /* ---------------------------------------------------------------- *
   * settings
   * ---------------------------------------------------------------- */

  ipcMain.handle(IPC.SettingsGet, () => settingsStore.get())

  // Side effects (theme, log cap, broadcast) come from the store's change event,
  // registered once in index.ts - calling applySettings here too would double-fire.
  ipcMain.handle(IPC.SettingsUpdate, (_event, patch: Partial<Settings>) =>
    settingsStore.update(patch ?? {})
  )

  ipcMain.handle(IPC.SettingsReset, () => settingsStore.reset())

  /* ---------------------------------------------------------------- *
   * engine
   * ---------------------------------------------------------------- */

  ipcMain.handle(IPC.EngineStatus, () => engineManager.state)
  ipcMain.handle(IPC.EngineDetect, (_e, force?: boolean) => engineManager.detect(force === true))
  ipcMain.handle(IPC.EngineInstall, (_e, version?: string) => engineManager.install(version ?? ''))
  ipcMain.handle(IPC.EngineUninstall, () => engineManager.uninstall())
  ipcMain.handle(IPC.EngineReleases, () =>
    wrap(() => engineManager.releases(30))
  )
  ipcMain.handle(IPC.AppCheckUpdate, () => checkAppUpdate())

  /* ---------------------------------------------------------------- *
   * profiles (multi-account)
   * ---------------------------------------------------------------- */

  ipcMain.handle(IPC.ProfilesList, () => profileViews())

  ipcMain.handle(IPC.ProfilesAdd, async (_e, name: string) => {
    // A brand-new profile has no session; clear the cached account so the login
    // dialog never shows the previous profile's identity.
    await migrateLegacyState().catch(() => null)
    profiles.add(String(name ?? ''))
    setAccount(null)
    return profileViews()
  })

  ipcMain.handle(IPC.ProfilesSetPassword, async (_e, id: string, password: string, email: string) => {
    await credentials.set(String(id), String(password ?? ''), String(email ?? ''))
    return profileViews()
  })

  ipcMain.handle(IPC.ProfilesForgetPassword, async (_e, id: string) => {
    await credentials.clear(String(id))
    return profileViews()
  })

  ipcMain.handle(IPC.ProfilesRename, async (_e, id: string, name: string) => {
    profiles.rename(String(id), String(name ?? ''))
    return profileViews()
  })

  ipcMain.handle(IPC.ProfilesSetStateDir, (_e, id: string, dir: string) => {
    const profile = profiles.get(String(id))
    if (!profile) return profileViews()
    const next = profiles.list().map((p) => (p.id === id ? { ...p, stateDir: String(dir ?? '') } : p))
    // Go through update() so the new list passes normalizeSettings/coerceProfile
    // like every other write; override() + persistNow() bypassed validation.
    settingsStore.update({ profiles: next })
    return profileViews()
  })

  ipcMain.handle(IPC.ProfilesRemove, async (_e, id: string) => {
    const result = await profiles.remove(String(id))
    await credentials.clear(String(id)).catch(() => {})
    cachedAccount = null
    await refreshActiveAccount()
    return { profiles: await profileViews(), removedDir: result.removedDir }
  })

  ipcMain.handle(IPC.ProfilesSetActive, async (_e, id: string) => {
    await migrateLegacyState().catch(() => null)
    const target = profiles.get(String(id))
    profiles.setActive(String(id))
    // Immediately drop the previous identity so no UI can show it for the new
    // profile.
    setAccount(null)
    if (!target) return { profiles: await profileViews(), account: null, needs2fa: false }

    // On macOS / keyring-backed Linux the OS keychain holds a single machine-wide
    // session, so "switching" must re-authenticate the target account. With a
    // stored password this is silent; otherwise the user signs in manually.
    const credential = await credentials.get(target.id)
    // Only auto-login when the stored pair actually belongs to this profile.
    // A password captured for another Apple ID must never be replayed here:
    // doing so would write that account's session into this profile's
    // directory, which is exactly the "switching back overwrote it" report.
    const storedMatches =
      credential !== null &&
      (!target.email || !credential.email || credential.email === target.email.trim().toLowerCase())
    if (credential && storedMatches) {
      const result = await ipatoolApi.login(
        credential.email || target.email,
        credential.password,
        undefined,
        target.id
      )
      if (result.status === 'ok' && result.account) {
        setAccount(result.account)
        return { profiles: await profileViews(), account: result.account, needs2fa: false }
      }
      if (result.status === 'needs-2fa') {
        return { profiles: await profileViews(), account: null, needs2fa: true }
      }
    }

    const account = await refreshActiveAccount()
    return { profiles: await profileViews(), account, needs2fa: false }
  })

  ipcMain.handle(IPC.ProfilesRefreshInfo, async (_e, id: string) => {
    const account = await ipatoolApi.accountInfoOrNull(String(id)).catch(() => null)
    return { profiles: await profileViews(), account }
  })

  /* ---------------------------------------------------------------- *
   * auth
   * ---------------------------------------------------------------- */

  ipcMain.handle(
    IPC.AuthLogin,
    async (_e, email: string, password: string, authCode?: string, profileId?: string) => {
      const result = await ipatoolApi.login(
        String(email ?? ''),
        String(password ?? ''),
        authCode,
        profileId
      )
      const isActive = !profileId || profileId === profiles.active().id
      if (result.status === 'ok' && result.account && isActive) setAccount(result.account)
      return result
    }
  )

  ipcMain.handle(IPC.AuthAccount, () => cachedAccount)

  ipcMain.handle(IPC.AuthRefresh, async (_e, profileId?: string) => {
    const account = await ipatoolApi.accountInfoOrNull(profileId).catch(() => null)
    if (!profileId || profileId === profiles.active().id) setAccount(account)
    return account
  })

  ipcMain.handle(IPC.AuthRevoke, async () => {
    const result = await wrap(() => ipatoolApi.revoke())
    if (result.ok) setAccount(null)
    return result
  })

  /* ---------------------------------------------------------------- *
   * store
   * ---------------------------------------------------------------- */

  ipcMain.handle(IPC.StoreSearch, (_e, request: { term: string; limit?: number; platform?: Settings['defaultPlatform'] }) =>
    wrap(() => ipatoolApi.search(String(request?.term ?? ''), request?.limit, request?.platform))
  )

  ipcMain.handle(IPC.StoreVersions, (_e, selector: { appId?: number; bundleID?: string }, platform?: Settings['defaultPlatform']) =>
    wrap(() => ipatoolApi.listVersions(selector ?? {}, platform))
  )

  ipcMain.handle(
    IPC.StoreVersionMetadata,
    (_e, selector: { appId?: number; bundleID?: string }, externalVersionID: string, platform?: Settings['defaultPlatform']) =>
      wrap(() => ipatoolApi.getVersionMetadata(selector ?? {}, String(externalVersionID), platform))
  )

  ipcMain.handle(IPC.StorePurchases, (_e, request?: { page?: number; maxResults?: number; platform?: Settings['defaultPlatform'] }) =>
    wrap(() => ipatoolApi.listPurchases(request?.page ?? 1, request?.maxResults, request?.platform))
  )

  ipcMain.handle(IPC.StorePurchase, (_e, selector: { appId?: number; bundleID?: string }, platform?: Settings['defaultPlatform']) =>
    wrap(() => ipatoolApi.purchase(selector ?? {}, platform))
  )

  /* ---------------------------------------------------------------- *
   * queue
   * ---------------------------------------------------------------- */

  ipcMain.handle(IPC.QueueGet, () => downloadQueue.snapshot())

  ipcMain.handle(IPC.QueueEnqueue, async (_e, options: { items?: DownloadRequest[] }) => {
    const items = Array.isArray(options?.items) ? options.items : []
    const settings = settingsStore.getInternal()
    await mkdir(settings.downloadDir, { recursive: true }).catch(() => {})
    return downloadQueue.enqueue(items)
  })

  ipcMain.handle(IPC.QueueControl, (_e, id: string, action: string) => {
    const requested = String(action ?? '')
    // The preload contract types this as QueueAction, but types do not exist at
    // runtime: validate against the same union before handing it to the queue.
    if (!QUEUE_ACTIONS.has(requested as QueueAction)) return
    return downloadQueue.control(String(id), requested)
  })

  ipcMain.handle(IPC.QueueClearFinished, () => downloadQueue.clearFinished())

  ipcMain.handle(IPC.QueueSetConcurrency, (_e, value: number) => {
    downloadQueue.setConcurrency(Number(value) || 1)
    settingsStore.update({ concurrency: Math.min(8, Math.max(1, Math.round(Number(value) || 1))) })
  })

  ipcMain.handle(IPC.QueueDeletePartial, (_e, id: string) => downloadQueue.deletePartial(String(id)))

  ipcMain.handle(IPC.QueueImport, async () => {
    const win = mainWindow()
    if (!win) return 0
    const picked = await dialog.showOpenDialog(win, {
      title: 'Import a download list',
      properties: ['openFile'],
      filters: [
        { name: 'JSON / text', extensions: ['json', 'txt'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    const file = picked.filePaths[0]
    if (picked.canceled || !file) return 0

    const text = await readFile(file, 'utf8')
    const requests = parseImportList(text)
    if (requests.length === 0) return 0
    downloadQueue.enqueue(requests)
    return requests.length
  })

  /* ---------------------------------------------------------------- *
   * artwork
   * ---------------------------------------------------------------- */

  ipcMain.handle(IPC.ArtworkGet, (_e, appId: number, country?: string) =>
    artworkCache.get(Number(appId), country).catch(() => null)
  )
  ipcMain.handle(IPC.ArtworkClearCache, () => artworkCache.clear())

  /* ---------------------------------------------------------------- *
   * filesystem & shell
   * ---------------------------------------------------------------- */

  ipcMain.handle(IPC.FsPickDirectory, async (_e, title?: string, defaultPath?: string) => {
    const win = mainWindow()
    const options: Electron.OpenDialogOptions = {
      title: title ?? 'Choose a folder',
      properties: ['openDirectory', 'createDirectory'],
      ...(defaultPath ? { defaultPath } : {})
    }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  ipcMain.handle(IPC.FsPickFile, async (_e, title?: string, filters?: Electron.FileFilter[]) => {
    const win = mainWindow()
    const options: Electron.OpenDialogOptions = {
      title: title ?? 'Choose a file',
      properties: ['openFile'],
      ...(Array.isArray(filters) && filters.length > 0 ? { filters } : {})
    }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  ipcMain.handle(IPC.FsReveal, (_e, target: string) => {
    if (typeof target === 'string' && target !== '') shell.showItemInFolder(target)
  })

  ipcMain.handle(IPC.FsOpenPath, async (_e, target: string) => {
    const raw = String(target ?? '').trim()
    if (raw === '') throw new Error('No path given')
    const resolved = path.resolve(expandUserPath(raw))

    // shell.openPath launches executables, so a compromised renderer must
    // never be able to point it at an arbitrary file. Only paths the app
    // plausibly owns are allowed: the download directory, our userData, or a
    // queue item's output directory - and inside those, only package/log files
    // or directories (opening a folder in the file manager is harmless).
    const roots = [
      settingsStore.getInternal().downloadDir,
      app.getPath('userData'),
      ...downloadQueue.snapshot().items.map((item) => item.outputDir)
    ]
      .filter((dir): dir is string => typeof dir === 'string' && dir.trim() !== '')
      .map((dir) => path.resolve(expandUserPath(dir)))
    if (!roots.some((root) => isInsideRoot(resolved, root))) {
      throw new Error('Refused to open a path outside the download / userData directories')
    }

    let isDirectory = false
    try {
      isDirectory = (await stat(resolved)).isDirectory()
    } catch {
      // A missing file falls through to openPath, which reports it readably.
    }
    if (!isDirectory && !OPENABLE_FILE.test(resolved)) {
      throw new Error('Refused to open a file with a disallowed extension')
    }
    return shell.openPath(resolved)
  })

  ipcMain.handle(IPC.FsExists, async (_e, target: string) => {
    try {
      await stat(String(target ?? ''))
      return true
    } catch {
      return false
    }
  })

  ipcMain.handle(IPC.FsStatPackage, async (_e, target: string) => {
    try {
      const info = await stat(String(target ?? ''))
      return { size: info.size, mtime: info.mtimeMs }
    } catch {
      return { size: null, mtime: null }
    }
  })

  ipcMain.handle(IPC.ShellOpenExternal, (_e, url: string) => {
    // Never let the renderer hand us file:// or a custom scheme.
    if (/^https?:\/\//i.test(String(url ?? ''))) return shell.openExternal(String(url))
    return Promise.resolve()
  })

  ipcMain.handle(IPC.ShellCopy, (_e, text: string) => {
    clipboard.writeText(String(text ?? ''))
  })

  /* ---------------------------------------------------------------- *
   * tasks & logs
   * ---------------------------------------------------------------- */

  ipcMain.handle(IPC.TasksList, () => taskRegistry.list())
  ipcMain.handle(IPC.TasksGet, (_e, id: string) => taskRegistry.get(String(id)))
  ipcMain.handle(IPC.TasksClear, () => taskRegistry.clear())
  ipcMain.handle(IPC.TasksCancel, (_e, id: string) => {
    taskRegistry.cancel(String(id))
  })

  ipcMain.handle(IPC.TasksExport, async () => {
    const win = mainWindow()
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const options: Electron.SaveDialogOptions = {
      title: 'Export activity log',
      defaultPath: path.join(app.getPath('documents'), `ipatool-gui-log-${stamp}.txt`)
    }
    const picked = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    if (picked.canceled || !picked.filePath) return null

    const lines: string[] = [
      `${APP_PRODUCT} ${APP_VERSION} - activity log`,
      `exported: ${new Date().toISOString()}`,
      `platform: ${process.platform}/${process.arch}`,
      `engine: ${engineManager.state.path ?? 'not found'} (${engineManager.state.version ?? '?'})`,
      ''
    ]
    for (const task of taskRegistry.list()) {
      lines.push(`=== [${task.id}] ${task.kind} - ${task.label} - ${task.state} (exit ${task.exitCode ?? '-'}) ===`)
      lines.push(`cmd: ${task.command}`)
      for (const line of task.lines) {
        lines.push(`${new Date(line.t).toISOString()} ${line.stream}/${line.level}: ${line.text}`)
      }
      lines.push('')
    }
    await writeFile(picked.filePath, lines.join('\n'), 'utf8')
    return picked.filePath
  })

  /* ---------------------------------------------------------------- *
   * raw console
   * ---------------------------------------------------------------- */

  ipcMain.handle(IPC.RunRaw, (_e, request: RawRunRequest) => {
    const args = Array.isArray(request?.args) ? request.args.map(String) : []
    if (args.length === 0) {
      return Promise.resolve(rawFailure('No arguments given'))
    }
    // Confused-deputy guard: the raw console is a passthrough for *read-only*
    // commands. Write-side subcommands (auth login/revoke, download --purchase,
    // purchase) must use their dedicated IPC channels, which carry 2FA
    // handling, profile scoping and credential storage. Without this, a
    // compromised renderer could sign the machine into an attacker's Apple ID
    // or buy apps on the user's account.
    const sub = args[0] ?? ''
    if (sub === 'auth') {
      const authSub = args[1] ?? ''
      if (!RAW_ALLOWED_AUTH_SUBCOMMANDS.has(authSub)) {
        return Promise.resolve(
          rawFailure(
            `Refused: 'auth ${authSub || '...'}' must use the dedicated sign-in / sign-out controls, not the raw console`
          )
        )
      }
    } else if (!RAW_ALLOWED_SUBCOMMANDS.has(sub)) {
      return Promise.resolve(
        rawFailure(`Refused: subcommand '${sub}' is not allowed in the raw console (read-only commands only)`)
      )
    }
    return wrap(() => ipatoolApi.runRaw(args, request?.interactive === true))
  })

  /* ---------------------------------------------------------------- *
   * window
   * ---------------------------------------------------------------- */

  ipcMain.on(IPC.WindowMinimize, () => mainWindow()?.minimize())
  ipcMain.on(IPC.WindowToggleMaximize, () => {
    const win = mainWindow()
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.on(IPC.WindowClose, () => mainWindow()?.close())
}

/** Applies side effects whenever settings change. */
export function applySettings(settings: Settings): void {
  nativeTheme.themeSource = settings.theme
  syncTitleBarOverlay(mainWindow())
  taskRegistry.setLineCap(settings.maxLogLines)
  broadcast('settings:changed', settings)
}

/** Profiles annotated with active flag, resolved directory and password state. */
async function profileViews(): Promise<ProfileView[]> {
  const activeId = profiles.active().id
  // Parallel: the per-profile credential lookup is independent I/O, and this
  // helper sits in the hot path of ~11 IPC handlers.
  return Promise.all(
    profiles.list().map(async (profile): Promise<ProfileView> => ({
      ...profile,
      active: profile.id === activeId,
      dir: profiles.dirFor(profile),
      hasPassword: await credentials.has(profile.id)
    }))
  )
}

/** Re-reads the active profile's session and broadcasts it. */
async function refreshActiveAccount(): Promise<AccountInfo | null> {
  const account = await ipatoolApi.accountInfoOrNull().catch(() => null)
  setAccount(account)
  return account
}

/** Emits task/queue events to the renderer and raises OS notifications. */
export function registerEventForwarding(): void {
  taskRegistry.on('created', (task) => broadcast('task:created', task))
  taskRegistry.on('log', (payload) => broadcast('task:log', payload))
  taskRegistry.on('finished', (task) => broadcast('task:finished', task))

  engineManager.on('status', (status: EngineStatus) => {
    broadcast('engine:status', status)
  })

  downloadQueue.on('snapshot', (snapshot) => broadcast('queue:snapshot', snapshot))
  downloadQueue.on('progress', (progress) => broadcast('queue:progress', progress))
  downloadQueue.on('item-finished', (item: QueueItem) => {
    broadcast('queue:item-finished', item)
    if (!settingsStore.getInternal().notifyOnComplete) return
    if (!Notification.isSupported()) return
    try {
      const notification = new Notification({
        title: item.state === 'done' ? 'Download complete' : 'Download failed',
        body: notificationBody(item),
        silent: item.state === 'done'
      })
      notification.on('click', () => {
        if (item.state === 'done' && item.outputPath) shell.showItemInFolder(item.outputPath)
        mainWindow()?.show()
      })
      notification.show()
    } catch {
      /* notifications are best effort */
    }
  })

  nativeTheme.on('updated', () => {
    broadcast('system:theme', nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
    syncTitleBarOverlay(mainWindow())
  })
}

/** Preview of the command the raw console is about to run. */
export function previewRawCommand(args: string[]): string {
  return `ipatool ${quoteCommand(redactArgs(args))}`
}
