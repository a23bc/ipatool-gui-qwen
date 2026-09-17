/**
 * Types shared by the main process, the preload bridge and the renderer.
 *
 * This module must stay free of both DOM and Node APIs so it can be imported
 * from either side.
 */

/** App Store platform token accepted by ipatool's `--platform` flag. */
export type Platform = '' | 'iphone' | 'ipad' | 'appletv' | 'visionos' | 'macos'

export const PLATFORMS: Platform[] = ['', 'iphone', 'ipad', 'appletv', 'visionos', 'macos']

/** Shape of a single app as emitted by ipatool in `--format json`. */
export interface StoreApp {
  id: number
  bundleID: string
  name: string
  version: string
  price: number
  purchaseDate?: string
  platforms?: string[]
}

export interface SearchResult {
  count: number
  apps: StoreApp[]
}

export interface PurchasesResult {
  count: number
  totalCount: number
  page: number
  apps: StoreApp[]
}

export interface VersionsResult {
  bundleID: string
  externalVersionIdentifiers: string[]
  latestExternalVersionID?: string
}

export interface VersionMetadata {
  externalVersionID: string
  displayVersion: string
  releaseDate?: string
}

export interface AccountInfo {
  name: string
  email: string
}

export interface DownloadOutcome {
  output: string
  purchased: boolean
}

export interface PurchaseOutcome {
  alreadyOwned: boolean
}

/* ------------------------------------------------------------------ *
 * Engine (the ipatool binary)
 * ------------------------------------------------------------------ */

export type EngineState = 'idle' | 'checking' | 'ready' | 'missing' | 'downloading' | 'error'

export interface EngineDownloadProgress {
  received: number
  total: number | null
  percent: number | null
  phase: 'resolve' | 'download' | 'verify' | 'extract'
}

export interface EngineStatus {
  state: EngineState
  /** Absolute path of the binary that will be executed, if any. */
  path: string | null
  version: string | null
  /** Where the binary came from. */
  source: 'settings' | 'env' | 'path' | 'managed' | null
  message: string | null
  /** Error code used by the renderer to pick a translated hint. */
  code: EngineErrorCode | null
  download: EngineDownloadProgress | null
}

/**
 * Runtime mirror of the engine error codes, so the renderer can validate a
 * code received over IPC before turning it into an i18n key.
 *
 * `null` deliberately lives on {@link EngineStatus.code} (absence of an error),
 * not inside the code union itself.
 */
export const ENGINE_ERROR_CODES = [
  'not-found',
  'download-failed',
  'checksum-mismatch',
  'extract-failed',
  'unsupported-arch',
  'not-executable',
  'network'
] as const

export type EngineErrorCode = (typeof ENGINE_ERROR_CODES)[number]

export interface EngineRelease {
  version: string
  publishedAt: string | null
  prerelease: boolean
  hasAssetForThisPlatform: boolean
}

/* ------------------------------------------------------------------ *
 * Tasks & logs
 * ------------------------------------------------------------------ */

export type TaskKind =
  | 'login'
  | 'account'
  | 'revoke'
  | 'search'
  | 'versions'
  | 'metadata'
  | 'purchases'
  | 'purchase'
  | 'download'
  | 'engine'
  | 'raw'

export type TaskState = 'running' | 'succeeded' | 'failed' | 'canceled'

export interface TaskRecord {
  id: string
  kind: TaskKind
  label: string
  state: TaskState
  startedAt: number
  endedAt: number | null
  /** Command line, already redacted of secrets. */
  command: string
  exitCode: number | null
  lines: LogLine[]
}

export interface LogLine {
  t: number
  stream: 'stdout' | 'stderr' | 'system'
  level: 'info' | 'warn' | 'error' | 'debug' | 'progress'
  text: string
}

/* ------------------------------------------------------------------ *
 * Download queue
 * ------------------------------------------------------------------ */

export type QueueState =
  | 'queued'
  | 'running'
  | 'paused'
  | 'done'
  | 'error'
  | 'canceled'
  | 'waiting'

export interface QueueProgress {
  received: number
  total: number | null
  percent: number | null
  /** bytes / second, smoothed */
  speed: number
  etaSec: number | null
}

export interface QueueItem {
  id: string
  appId: number
  bundleID: string
  name: string
  /** Display version, when known. */
  version: string
  platform: Platform
  externalVersionID: string
  purchase: boolean
  outputDir: string
  state: QueueState
  /**
   * Account this download runs as; '' for items persisted before multi-account
   * existed, which then fall back to whoever is active when they resume.
   */
  accountId: string
  progress: QueueProgress
  outputPath: string | null
  fileSize: number | null
  error: { message: string; hint: string | null } | null
  taskId: string | null
  attempts: number
  addedAt: number
  startedAt: number | null
  finishedAt: number | null
  artworkKey: number | null
}

export interface QueueSnapshot {
  items: QueueItem[]
  concurrency: number
  active: number
}

export interface DownloadRequest {
  appId?: number
  bundleID?: string
  name?: string
  version?: string
  platform?: Platform
  externalVersionID?: string
  purchase?: boolean
  outputDir?: string
  /** Account to download as; defaults to the active one. */
  accountId?: string
  /** App ID used to reuse an already-cached icon in the queue row. */
  artworkKey?: number
}

/* ------------------------------------------------------------------ *
 * Accounts (several App Store sessions side by side)
 * ------------------------------------------------------------------ */

/**
 * Where ipatool keeps an account's credential record.
 *
 * `'file'` means the record lives inside the account's own state directory, so
 * accounts are independent by construction. `'os'` means the platform hands out
 * one machine-wide slot (macOS Keychain / Linux Secret Service) which the GUI has
 * to point at the right account before each use - see `shared/accounts.ts`.
 */
export type CredentialStore = 'file' | 'os' | 'unknown'

/**
 * One App Store account.
 *
 * Each account owns an isolated ipatool session directory (`XDG_STATE_HOME`) plus
 * a sandboxed home directory, which is the mechanism upstream itself provides
 * (`cmd/state_directory.go`). The Apple ID password is *never* held here: it is
 * whatever ipatool wrote into the keyring, and on platforms with a shared slot a
 * verbatim (encrypted) copy of that record is kept next to the account so a
 * switch can restore it without asking for the password again.
 */
export interface AccountProfile {
  id: string
  /** Auto-managed label: the learned account name, else its e-mail. */
  name: string
  /** Free-form note the user can edit; never used as an identity. */
  remark: string
  /** Apple ID e-mail, learned from the session. */
  email: string
  /** DirectoryServicesID - the strongest identity token Apple gives us. */
  dsid: string
  credentialStore: CredentialStore
  /**
   * This account's own `--keychain-passphrase`, stored encrypted with
   * `safeStorage`. Each account gets its own so that one leaked passphrase
   * cannot unlock every session on the machine; it is never sent to the
   * renderer and never leaves the main process in plaintext.
   */
  passphrase: string
  createdAt: number
  lastUsedAt: number
}

/** Rendered projection of an account, annotated with live session state. */
export interface AccountView {
  id: string
  name: string
  remark: string
  email: string
  /** True when the account's own session answered an identity probe. */
  signedIn: boolean
  active: boolean
  credentialStore: CredentialStore
  /** Absolute session directory ipatool is pointed at for this account. */
  stateDir: string
  createdAt: number
  lastUsedAt: number
  /**
   * Set when the session answered with a *different* account than the one
   * recorded. Surfaced instead of silently acting as the wrong Apple ID.
   */
  conflict: 'foreign-session' | 'unreadable-slot' | null
}

/** Snapshot of the account list plus the platform's credential-slot capability. */
export interface AccountsSnapshot {
  accounts: AccountView[]
  activeId: string
  /** 'os' when every account competes for one machine-wide credential slot. */
  credentialSlot: 'file' | 'os'
  /** Whether the GUI is able to move a saved record back into that slot. */
  slotBridge: 'available' | 'unavailable' | 'not-needed'
  /** Environment/os-specific explanation shown in the accounts panel. */
  slotDetail: string
  /** Result of the one-time reconciliation of `~/.ipatool`, for the UI notice. */
  legacy: { adopted: boolean; quarantined: string | null } | null
}

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

export type ThemeMode = 'system' | 'light' | 'dark'
export type LocaleMode = 'system' | 'zh-CN' | 'en-US'
export type PassphraseMode = 'auto' | 'manual' | 'none'

export interface Settings {
  /** Manual override for the ipatool binary location. */
  ipatoolPath: string
  /** Automatically download ipatool from GitHub releases when missing. */
  autoInstallEngine: boolean
  /** Pin a specific ipatool version ("" = latest). */
  engineVersion: string
  /** Prefix prepended to github.com URLs (for mirrors / proxies). */
  githubMirror: string
  downloadDir: string
  concurrency: number
  autoPurchase: boolean
  defaultPlatform: Platform
  searchLimit: number
  purchasesPageSize: number
  passphraseMode: PassphraseMode
  /**
   * Only meaningful when passphraseMode === 'manual'; encrypted at rest.
   * When '' each account gets its own generated passphrase instead.
   */
  keychainPassphrase: string
  /**
   * Runs ipatool with a per-account home directory.
   *
   * Upstream prefers `$HOME/.ipatool` whenever it exists, which would make every
   * account share one session; the sandbox is what makes the per-account
   * `XDG_STATE_HOME` authoritative. Turn it off only if a future ipatool build
   * starts reading home for something else and the sandbox gets in the way.
   */
  isolateSessionHome: boolean
  /** Registered accounts; always contains at least one entry. */
  accounts: AccountProfile[]
  activeAccountId: string
  /** Monotonic counter behind the "Account N" labels. */
  accountCounter: number
  verbose: boolean
  theme: ThemeMode
  locale: LocaleMode
  artworkEnabled: boolean
  /** Country used only for artwork lookup; ipatool itself takes the storefront
   *  from the signed-in account. */
  artworkCountry: string
  maxLogLines: number
  resumeQueueOnLaunch: boolean
  notifyOnComplete: boolean
  confirmCloseWhileDownloading: boolean
  /** Convenience only - the password is never persisted. */
  lastEmail: string
}

/* ------------------------------------------------------------------ *
 * Login flow
 * ------------------------------------------------------------------ */

export type LoginStatus =
  | 'ok'
  | 'needs-2fa'
  | 'bad-credentials'
  | 'passphrase-required'
  | 'rate-limited'
  | 'error'

export interface LoginResult {
  status: LoginStatus
  account: AccountInfo | null
  message: string
  taskId: string
}

/* ------------------------------------------------------------------ *
 * IPC payloads
 * ------------------------------------------------------------------ */

export interface AppInfoPayload {
  appVersion: string
  electronVersion: string
  chromeVersion: string
  nodeVersion: string
  platform: NodePlatform
  arch: string
  locale: string
  isDev: boolean
  paths: { userData: string; downloads: string; documents: string }
}

export type NodePlatform = 'darwin' | 'linux' | 'win32'

export interface OperationResult<T> {
  ok: true
  data: T
  taskId: string
}

export interface OperationFailure {
  ok: false
  error: string
  hint: string | null
  code: string | null
  taskId: string
  exitCode: number | null
}

export type Operation<T> = OperationResult<T> | OperationFailure

export interface RawRunRequest {
  args: string[]
  interactive?: boolean
}

export interface UpdateCheckResult {
  current: string
  latest: string | null
  hasUpdate: boolean
  url: string | null
  publishedAt: string | null
  error: string | null
}

/** High-frequency progress event pushed from the main process. */
export interface ProgressEvent {
  id: string
  received: number
  total: number | null
  percent: number | null
  speed: number
  etaSec: number | null
}
