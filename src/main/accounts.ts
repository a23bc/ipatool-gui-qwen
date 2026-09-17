/**
 * The account registry: several App Store sessions side by side.
 *
 * Four upstream facts drive every decision in this file (all from ipatool v2.6):
 *
 * 1. `cmd/state_directory.go` resolves the session directory from
 *    `$XDG_STATE_HOME/ipatool` (or `$XDG_DATA_HOME/ipatool`) when the variable is
 *    absolute, and falls back to `$HOME/.ipatool` otherwise - preferring that
 *    legacy path whenever it exists, and *renaming it* into the XDG target when
 *    it does not. Both branches make sessions collide, so every invocation gets
 *    an absolute `XDG_STATE_HOME` **and** a sandboxed home directory
 *    (`HOMEDRIVE`/`HOMEPATH` on Windows, `HOME` elsewhere - `machine.HomeDirectory`
 *    is the only consumer of either, so nothing else in ipatool is affected).
 *    The sandbox is also why the user's real `~/.ipatool` is never moved or
 *    deleted: ipatool simply cannot see it.
 *
 * 2. `cmd/common.go` + `cmd/constants.go` open the keyring with the constant
 *    service name `ipatool-auth.service` and the backend order
 *    `[keychain, secret-service, file]`, and `keyring.Open` takes the first
 *    backend that opens. Only `file` is scoped to the state directory, so on
 *    macOS the slot is machine-wide for every account - which is why
 *    {@link AccountRegistry.acquire} moves the right record into it (and
 *    serialises access while it is there) whenever {@link detectCredentialStore}
 *    says the account is not self-contained.
 *
 * 3. `pkg/appstore/appstore_login.go` writes the *whole* `Account` struct -
 *    password included - under the key `account`, and every store command reads
 *    it back before doing anything (`cmd/search.go` and friends). A verbatim copy
 *    is therefore the only way to restore a session on a shared-slot platform,
 *    and it is encrypted with `safeStorage` at rest, exactly like the keychain
 *    passphrase. It is written **only** when the account actually needs it.
 *
 * 4. `cmd/auth.go` has no `--account`/`--profile` flag: the "current account" is
 *    nothing but the directory plus the slot, so switching is a filesystem and
 *    (sometimes) keyring operation, never a re-login.
 */

import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'
import type { AccountProfile, AccountView, AccountsSnapshot, CredentialStore, NodePlatform } from '../shared/types'
import {
  LEGACY_STATE_DIRNAME,
  XDG_STATE_SUBDIR,
  accountDirName,
  accountDisplayName,
  allocateAccountName,
  identityOf,
  isAccountId,
  newAccountId,
  parseAccountRecord,
  probableCredentialSlot,
  profileIdentity,
  sameIdentity,
  slotOwner,
  sortAccounts
} from '../shared/accounts'
import type { IpatoolErrorCode } from '../shared/ipatool/errors'
import { fileExists } from './paths'
import { readSlot, slotBridge, writeSlot } from './keyringSlot'
import { decryptSecret, encryptSecret, settingsStore } from './settings'

/** Failure that the IPC layer turns into a translated, actionable message. */
export class AccountError extends Error {
  constructor(
    message: string,
    readonly code: IpatoolErrorCode
  ) {
    super(message)
    this.name = 'AccountError'
  }
}

const ENCRYPTED_PREFIX = 'enc:v1:'
const AUTO_LABEL = /^account\s+\d+$/i

/* ------------------------------------------------------------------ *
 * paths
 * ------------------------------------------------------------------ */

/** Root that holds every account's session, home sandbox and saved record. */
export function accountsRoot(): string {
  return path.join(app.getPath('userData'), 'accounts')
}

function accountDir(id: string): string {
  return path.join(accountsRoot(), accountDirName(id))
}

/** Value handed to ipatool as `XDG_STATE_HOME`; it appends `/ipatool`. */
export function stateDirFor(id: string): string {
  return path.join(accountDir(id), 'state')
}

/**
 * Per-account home sandbox.
 *
 * ipatool only reads it to build the legacy `$HOME/.ipatool` path, which must
 * never resolve to the user's real home: upstream prefers that directory whenever
 * it exists, so one stray CLI session would otherwise be shared by every account.
 */
export function homeDirFor(id: string): string {
  return path.join(accountDir(id), 'home')
}

function snapshotPathFor(id: string): string {
  return path.join(accountDir(id), 'account.enc')
}

/* ------------------------------------------------------------------ *
 * leases
 * ------------------------------------------------------------------ */

export interface AccountLease {
  account: AccountProfile
  /** Environment fragment selecting this account's session. */
  env: Record<string, string>
  /** `--keychain-passphrase` value for this account. */
  passphrase: string
  /** Must be called once the command has finished. */
  release: () => void
}

/* ------------------------------------------------------------------ *
 * registry
 * ------------------------------------------------------------------ */

export class AccountRegistry extends EventEmitter {
  private started = false
  private migration: Promise<{ adopted: boolean; quarantined: string | null } | null> | null = null
  /** Accounts whose session last answered with a foreign identity. */
  private readonly conflicts = new Map<string, AccountView['conflict']>()
  /** FIFO lock serialising use of a machine-wide credential slot. */
  private slotChain: Promise<void> = Promise.resolve()

  /* ---------------- accessors ---------------- */

  list(): AccountProfile[] {
    return settingsStore.getInternal().accounts
  }

  get(id: string): AccountProfile | null {
    return this.list().find((account) => account.id === id) ?? null
  }

  active(): AccountProfile {
    const settings = settingsStore.getInternal()
    return (
      this.get(settings.activeAccountId) ??
      sortAccounts(this.list())[0] ??
      this.create('')
    )
  }

  get activeId(): string {
    return this.active().id
  }

  /** True once a login has taught us an identity for this account. */
  hasRecordedSession(profile: AccountProfile): boolean {
    return profile.email.trim() !== '' || profile.dsid.trim() !== ''
  }

  view(profile: AccountProfile): AccountView {
    return {
      id: profile.id,
      name: profile.name,
      remark: profile.remark,
      email: profile.email,
      signedIn: this.hasRecordedSession(profile),
      active: profile.id === this.activeId,
      credentialStore: profile.credentialStore,
      stateDir: stateDirFor(profile.id),
      createdAt: profile.createdAt,
      lastUsedAt: profile.lastUsedAt,
      conflict: this.conflicts.get(profile.id) ?? null
    }
  }

  async snapshot(): Promise<AccountsSnapshot> {
    const bridge = await slotBridge()
    const profiles = sortAccounts(this.list())
    const shared = profiles.some((profile) => this.effectiveStore(profile) === 'os')
    return {
      accounts: profiles.map((profile) => this.view(profile)),
      activeId: this.activeId,
      credentialSlot: shared ? 'os' : 'file',
      slotBridge: shared ? (bridge.available ? 'available' : 'unavailable') : 'not-needed',
      slotDetail: bridge.detail,
      legacy: this.migration ? await this.migration.catch(() => null) : null
    }
  }

  /* ---------------- lifecycle ---------------- */

  /**
   * Guarantees at least one account exists and reconciles the legacy directory
   * when the home sandbox is switched off.
   */
  async init(): Promise<void> {
    if (this.started) return
    this.started = true
    const first = sortAccounts(this.list())[0] ?? this.create('')

    if (!settingsStore.getInternal().isolateSessionHome) {
      this.migration = this.reconcileLegacyState(first)
      await this.migration.catch(() => null)
    }
  }

  /* ---------------- mutations ---------------- */

  private commit(accounts: AccountProfile[], activeId: string, counter?: number): void {
    settingsStore.replaceAccounts(accounts, activeId, counter)
    this.emit('change')
  }

  /** Creates a fresh, empty account. */
  create(remark: string): AccountProfile {
    const current = this.list()
    const { name, counter } = allocateAccountName(current, settingsStore.getInternal().accountCounter)
    const now = Date.now()
    const profile: AccountProfile = {
      id: newAccountId(now, randomBytes(4).toString('hex')),
      name,
      remark: remark.trim().slice(0, 200),
      email: '',
      dsid: '',
      credentialStore: 'unknown',
      passphrase: '',
      createdAt: now,
      lastUsedAt: now
    }
    this.commit([...current, profile], profile.id, counter)
    return profile
  }

  /** Adds an account and makes it active. */
  add(remark = ''): AccountProfile {
    const profile = this.create(remark)
    void this.ensureDirs(profile)
    return profile
  }

  setRemark(id: string, remark: string): AccountProfile | null {
    const accounts = this.list().map((account) =>
      account.id === id ? { ...account, remark: remark.trim().slice(0, 200) } : account
    )
    this.commit(accounts, this.activeId)
    return this.get(id)
  }

  setCredentialStore(id: string, store: CredentialStore): void {
    const target = this.get(id)
    if (!target || target.credentialStore === store) return
    const accounts = this.list().map((account) =>
      account.id === id ? { ...account, credentialStore: store } : account
    )
    this.commit(accounts, this.activeId)
  }

  /**
   * Records the identity a session actually reported.
   *
   * A generated "Account N" label is replaced by the learned name (falling back
   * to the e-mail), so a profile is recognisable at a glance without the user
   * having to name anything; a label the user typed is left alone.
   */
  markIdentity(id: string, identity: { email: string; dsid: string; name: string }): void {
    const email = identity.email.trim()
    const dsid = identity.dsid.trim()
    const learned = identity.name.trim() || email
    const accounts = this.list().map((account) => {
      if (account.id !== id) return account
      return {
        ...account,
        email,
        dsid,
        name: AUTO_LABEL.test(account.name.trim()) && learned !== '' ? learned : account.name
      }
    })
    // A verified identity also clears whatever the previous probe complained about.
    this.conflicts.delete(id)
    this.commit(accounts, this.activeId)
  }

  /** Flags (or clears) a session/identity mismatch for the UI. */
  setConflict(id: string, conflict: AccountView['conflict']): void {
    const previous = this.conflicts.get(id) ?? null
    if (previous === conflict) return
    if (conflict === null) this.conflicts.delete(id)
    else this.conflicts.set(id, conflict)
    this.emit('change')
  }

  touch(id: string): void {
    const accounts = this.list().map((account) =>
      account.id === id ? { ...account, lastUsedAt: Date.now() } : account
    )
    settingsStore.replaceAccounts(accounts, this.activeId)
  }

  activate(id: string): AccountProfile | null {
    const profile = this.get(id)
    if (!profile) return null
    const accounts = this.list().map((account) =>
      account.id === id ? { ...account, lastUsedAt: Date.now() } : account
    )
    this.commit(accounts, id)
    return this.get(id)
  }

  /**
   * Removes an account and everything the app created for it.
   *
   * Only managed directories are touched - there is no way to point an account at
   * a path outside {@link accountsRoot}, so nothing the user made can be
   * destroyed here. The last account is replaced rather than removed, because
   * ipatool always needs somewhere to write.
   */
  async remove(id: string): Promise<{ removedDir: boolean; path: string | null }> {
    const profile = this.get(id)
    if (!profile) return { removedDir: false, path: null }

    let removedDir = false
    try {
      await rm(accountDir(profile.id), { recursive: true, force: true })
      removedDir = true
    } catch {
      removedDir = false
    }

    this.conflicts.delete(profile.id)
    const remaining = this.list().filter((account) => account.id !== id)
    if (remaining.length > 0) {
      const activeId = settingsStore.getInternal().activeAccountId === id ? remaining[0]!.id : this.activeId
      this.commit(remaining, activeId)
    } else {
      const replacement: AccountProfile = {
        id: newAccountId(Date.now(), randomBytes(4).toString('hex')),
        name: 'Account 1',
        remark: '',
        email: '',
        dsid: '',
        credentialStore: 'unknown',
        passphrase: '',
        createdAt: Date.now(),
        lastUsedAt: Date.now()
      }
      this.commit([replacement], replacement.id, 2)
    }
    return { removedDir, path: removedDir ? accountDir(profile.id) : null }
  }

  /* ---------------- environment ---------------- */

  /** Creates the account's state and home directories. */
  async ensureDirs(profile: AccountProfile): Promise<void> {
    await mkdir(stateDirFor(profile.id), { recursive: true }).catch(() => {})
    await mkdir(homeDirFor(profile.id), { recursive: true }).catch(() => {})
  }

  /**
   * Environment that pins one ipatool invocation to one account.
   *
   * See the module header: both halves are required. `XDG_STATE_HOME` selects the
   * cookies and (on the file backend) the credential record; the sandboxed home
   * removes the legacy fallback that would otherwise override both.
   */
  envFor(profile: AccountProfile): Record<string, string> {
    const env: Record<string, string> = { XDG_STATE_HOME: stateDirFor(profile.id) }
    if (!settingsStore.getInternal().isolateSessionHome) return env

    const home = homeDirFor(profile.id)
    if (process.platform === 'win32') {
      // `machine.HomeDirectory()` joins HOMEDRIVE and HOMEPATH, so the path has
      // to be split exactly the way it will be re-joined.
      const parsed = path.parse(home)
      env.HOMEDRIVE = parsed.root.replace(/[\\/]+$/, '')
      env.HOMEPATH = home.slice(parsed.root.length - 1)
    } else {
      env.HOME = home
    }
    return env
  }

  /**
   * The `--keychain-passphrase` for this account.
   *
   * Under the default `auto` policy every account gets its own generated value,
   * so a passphrase that leaks (or is captured by a backup) unlocks exactly one
   * session instead of the machine. `manual` reuses the user's global value and
   * `none` passes nothing at all, matching upstream's own options.
   */
  async passphraseFor(profile: AccountProfile): Promise<string> {
    const mode = settingsStore.getInternal().passphraseMode
    if (mode !== 'auto') return settingsStore.effectivePassphrase()

    // In memory the value is plaintext - `SettingsStore.load()` decrypts on the
    // way in and `persist()` re-encrypts on the way out.
    if (profile.passphrase !== '') return profile.passphrase

    // A passphrase only exists to unlock ipatool's own encrypted record, so the
    // only case that cannot be recovered is a record already written with a value
    // we no longer have (a different OS user, a rotated master key, a restored
    // settings file). Generating a replacement would leave the account unable to
    // read its own credentials, so it is reported instead.
    if ((await this.resolveCredentialStore(profile)) === 'file' && (await fileExists(this.keyringRecordPath(profile)))) {
      throw new AccountError(
        `The saved keychain passphrase for "${accountDisplayName(profile)}" is missing or unreadable. ` +
          'Sign in to this account again to create a new session.',
        'passphrase-invalid'
      )
    }

    const generated = await settingsStore.generateAccountPassphrase()
    if (generated === '') return ''
    const accounts = this.list().map((account) =>
      account.id === profile.id ? { ...account, passphrase: generated } : account
    )
    settingsStore.replaceAccounts(accounts, this.activeId)
    return generated
  }

  /* ---------------- credential store ---------------- */

  private stateDir(profile: AccountProfile): string {
    return stateDirFor(profile.id)
  }

  /** Where the `file` backend keeps this account's encrypted record. */
  private keyringRecordPath(profile: AccountProfile): string {
    return path.join(this.stateDir(profile), XDG_STATE_SUBDIR, 'account')
  }

  /**
   * Which credential store ipatool will use for this account.
   *
   * The `file` backend writes its record into `keyring.Config.FileDir`, which
   * `cmd/common.go` sets to the state directory, so the record's presence is
   * direct proof that the account is self-contained. Everything else is the
   * machine-wide slot, and is only believed once a record in it can be attributed
   * to this account.
   */
  private async detectCredentialStore(profile: AccountProfile): Promise<CredentialStore | null> {
    if (await fileExists(this.keyringRecordPath(profile))) return 'file'

    const { raw } = await readSlot()
    const record = parseAccountRecord(raw)
    if (record && sameIdentity(identityOf(record), profileIdentity(profile))) return 'os'
    return null
  }

  /**
   * The store to assume before anything is known about an account.
   *
   * Linux is forced onto the file backend by making the session bus unreachable
   * (see `runner.ts`), so it behaves like Windows here even though upstream's
   * default order would pick the Secret Service.
   */
  private expectedStore(): CredentialStore {
    if (process.platform === 'linux') return 'file'
    return probableCredentialSlot(process.platform as NodePlatform)
  }

  /** Resolves, persists and returns the effective store for an account. */
  async resolveCredentialStore(profile: AccountProfile): Promise<CredentialStore> {
    if (profile.credentialStore !== 'unknown') return profile.credentialStore
    const detected = await this.detectCredentialStore(profile)
    if (detected !== null) {
      this.setCredentialStore(profile.id, detected)
      return detected
    }
    return this.expectedStore()
  }

  private effectiveStore(profile: AccountProfile): CredentialStore {
    return profile.credentialStore === 'unknown' ? this.expectedStore() : profile.credentialStore
  }

  /* ---------------- saved records ---------------- */

  /**
   * Reads the account's saved credential record, or null.
   *
   * The record contains the Apple ID password (upstream stores the whole
   * `Account` struct), so it is only ever kept encrypted and never crosses the
   * IPC boundary.
   */
  async readSnapshot(profile: AccountProfile): Promise<string | null> {
    let stored: string
    try {
      stored = (await readFile(snapshotPathFor(profile.id), 'utf8')).trim()
    } catch {
      return null
    }
    if (stored === '') return null
    const raw = stored.startsWith(ENCRYPTED_PREFIX) ? decryptSecret(stored) : ''
    if (raw === '') return null
    return parseAccountRecord(raw) ? raw : null
  }

  /** Persists a verbatim record so a shared slot can be restored without a re-login. */
  async saveSnapshot(profile: AccountProfile, raw: string): Promise<boolean> {
    if (!parseAccountRecord(raw)) return false
    let sealed: string
    try {
      sealed = encryptSecret(raw)
    } catch {
      // Writing it in cleartext would put the Apple ID password on disk next to
      // the session, which is precisely what the keyring exists to avoid.
      return false
    }
    await mkdir(accountDir(profile.id), { recursive: true }).catch(() => {})
    await writeFile(snapshotPathFor(profile.id), sealed, { encoding: 'utf8', mode: 0o600 }).catch(() => {})
    return true
  }

  async clearSnapshot(profile: AccountProfile): Promise<void> {
    await rm(snapshotPathFor(profile.id), { force: true }).catch(() => {})
  }

  /** Records the current slot occupant as `profile`'s saved session, if it is ours. */
  async captureSlotIdentity(profile: AccountProfile): Promise<boolean> {
    const { raw } = await readSlot()
    const record = parseAccountRecord(raw)
    // `parseAccountRecord` already rejected null, but TypeScript cannot see that
    // through the function boundary.
    if (!record || raw === null) return false

    const observed = identityOf(record)
    const known = profileIdentity(profile)
    // Only adopt a record that cannot belong to somebody else. A slot with no
    // usable identity at all is still worth saving: it is the session we just
    // created, and refusing it would strand the account on a shared-slot system.
    if (known.email !== '' || known.dsid !== '') {
      if (!sameIdentity(known, observed)) return false
    }
    return this.saveSnapshot(profile, raw)
  }

  /* ---------------- leases ---------------- */

  /** FIFO lock; resolves with the function that must be called to release it. */
  private lockSlot(): Promise<() => void> {
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const previous = this.slotChain
    this.slotChain = previous.then(() => held)
    return previous.then(() => release)
  }

  /**
   * Makes the shared slot describe `profile`, if the account needs it.
   *
   * Read before write, always. Two cases, one rule:
   *
   *  - the occupant belongs to another account this app manages - it is copied
   *    into that account's saved record first, because on a shared-slot platform
   *    the incumbent account and the slot entry are the same object;
   *  - the occupant cannot be attributed to anyone (an older ipatool build's
   *    format, another tool using the same service name) - it is overwritten, and
   *    has to be, since nothing could restore it later and refusing would make the
   *    account permanently unusable.
   *
   * Deleting first is never an option: `security` updates in place and
   * `secret-tool store` overwrites, so a crash mid-switch cannot leave the user
   * with no record at all.
   */
  private async ensureSlot(profile: AccountProfile): Promise<void> {
    const bridge = await slotBridge()
    if (!bridge.available) {
      throw new AccountError(
        `This system stores ipatool credentials in one shared slot and the app cannot manage it: ${bridge.detail}`,
        'session-mismatch'
      )
    }

    const { raw } = await readSlot()
    const current = parseAccountRecord(raw)
    if (current && sameIdentity(identityOf(current), profileIdentity(profile))) return

    if (current && raw !== null) {
      const occupant = slotOwner(current, this.list())
      if (occupant && occupant.id !== profile.id) await this.saveSnapshot(occupant, raw)
    }

    const saved = await this.readSnapshot(profile)
    if (!saved) {
      throw new AccountError(
        `"${accountDisplayName(profile)}" has no restorable session. Sign in to it once to enable switching.`,
        'session-mismatch'
      )
    }

    const written = await writeSlot(saved)
    if (!written.ok) {
      throw new AccountError(`Could not restore the saved credentials: ${written.detail}`, 'session-mismatch')
    }
  }

  /**
   * Reserves one account for the duration of a command.
   *
   * On a shared-slot platform the slot is only correct for one account at a time,
   * so the lease doubles as a lock: concurrent downloads for different accounts
   * would otherwise overwrite each other's records mid-request. When credentials
   * are per-directory (Windows, Linux) there is no lock and the download pool
   * keeps its full parallelism.
   */
  async acquire(id?: string): Promise<AccountLease> {
    const profile = id ? this.get(id) : this.active()
    if (!profile) {
      throw new AccountError('No account is selected', 'profile-required')
    }

    await this.ensureDirs(profile)
    // The store is resolved before the passphrase: whether a passphrase is even
    // needed depends on it, and resolving it once keeps the persisted value and
    // the decision in step.
    const store = await this.resolveCredentialStore(profile)
    const passphrase = await this.passphraseFor(profile)
    const env = this.envFor(profile)

    if (store !== 'os') {
      this.touch(profile.id)
      return { account: profile, env, passphrase, release: () => {} }
    }

    const release = await this.lockSlot()
    try {
      await this.ensureSlot(profile)
    } catch (error) {
      release()
      throw error
    }
    this.touch(profile.id)
    return { account: profile, env, passphrase, release }
  }

  /* ---------------- legacy directory ---------------- */

  /**
   * One-time reconciliation of `~/.ipatool`, needed only when the home sandbox is
   * disabled.
   *
   * Upstream prefers that directory whenever it exists, and otherwise *renames*
   * it into whatever XDG target runs first - so leaving it in place would either
   * put every account back on one session or move the user's session into an
   * arbitrary account. It is adopted into the first account, or - if that
   * account already has state - parked under {@link accountsRoot} so nothing is
   * ever destroyed.
   */
  private async reconcileLegacyState(profile: AccountProfile): Promise<{
    adopted: boolean
    quarantined: string | null
  } | null> {
    const legacy = path.join(os.homedir(), LEGACY_STATE_DIRNAME)
    const exists = async (candidate: string): Promise<boolean> => {
      try {
        return (await stat(candidate)).isDirectory()
      } catch {
        return false
      }
    }
    if (!(await exists(legacy))) return null

    const target = path.join(stateDirFor(profile.id), XDG_STATE_SUBDIR)
    if (!(await exists(target))) {
      await mkdir(path.dirname(target), { recursive: true }).catch(() => {})
      try {
        await rename(legacy, target)
        return { adopted: true, quarantined: null }
      } catch {
        return null
      }
    }

    const parked = path.join(accountsRoot(), `legacy-${Date.now().toString(36)}`)
    try {
      await mkdir(accountsRoot(), { recursive: true })
      await rename(legacy, parked)
      return { adopted: false, quarantined: parked }
    } catch {
      return null
    }
  }
}

export const accounts = new AccountRegistry()

/** True when `value` can safely be used as an account id from IPC. */
export function assertAccountId(value: unknown): string {
  const id = typeof value === 'string' ? value.trim() : ''
  if (!isAccountId(id)) {
    throw new AccountError('No account is selected', 'profile-required')
  }
  return id
}
