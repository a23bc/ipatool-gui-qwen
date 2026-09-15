/**
 * The single contract between the main process, the preload bridge and the
 * renderer.
 *
 * `RendererApi` is implemented in `src/preload/index.ts` and consumed by the
 * renderer through `window.api`, so both sides are checked against the same
 * types at compile time - a renamed channel or a changed payload shape is a
 * build error, not a runtime surprise.
 */

import type {
  AccountInfo,
  AppInfoPayload,
  DownloadRequest,
  EngineRelease,
  EngineStatus,
  LogLine,
  LoginResult,
  Operation,
  Platform,
  ProgressEvent,
  PurchasesResult,
  QueueItem,
  QueueSnapshot,
  RawRunRequest,
  SearchResult,
  Settings,
  TaskRecord,
  UpdateCheckResult,
  VersionMetadata,
  VersionsResult,
  PurchaseOutcome
} from './types'
import type { Profile } from './types'
import type { AppSelector } from './ipatool/args'

/** A profile plus the derived bits the switcher UI needs. */
export interface ProfileView extends Profile {
  active: boolean
  /** Resolved state directory, shown for transparency. */
  dir: string
  /** Whether an encrypted password is stored for one-click switching. */
  hasPassword: boolean
}

export interface SwitchResult {
  profiles: ProfileView[]
  account: AccountInfo | null
  /** Silent re-login hit Apple's 2FA wall; the dialog must complete it. */
  needs2fa: boolean
}

/** Channel names for `ipcRenderer.invoke` (request/response). */
export const IPC = Object.freeze({
  AppInfo: 'app:info',

  SettingsGet: 'settings:get',
  SettingsUpdate: 'settings:update',
  SettingsReset: 'settings:reset',

  EngineStatus: 'engine:status',
  EngineDetect: 'engine:detect',
  EngineInstall: 'engine:install',
  EngineReleases: 'engine:releases',
  EngineUninstall: 'engine:uninstall',
  AppCheckUpdate: 'app:check-update',

  ProfilesList: 'profiles:list',
  ProfilesAdd: 'profiles:add',
  ProfilesRemove: 'profiles:remove',
  ProfilesRename: 'profiles:rename',
  ProfilesSetActive: 'profiles:set-active',
  ProfilesRefreshInfo: 'profiles:refresh-info',
  ProfilesSetStateDir: 'profiles:set-state-dir',
  ProfilesSetPassword: 'profiles:set-password',
  ProfilesForgetPassword: 'profiles:forget-password',

  AuthLogin: 'auth:login',
  AuthAccount: 'auth:account',
  AuthRefresh: 'auth:refresh',
  AuthRevoke: 'auth:revoke',

  StoreSearch: 'store:search',
  StoreVersions: 'store:versions',
  StoreVersionMetadata: 'store:version-metadata',
  StorePurchases: 'store:purchases',
  StorePurchase: 'store:purchase',

  QueueEnqueue: 'queue:enqueue',
  QueueControl: 'queue:control',
  QueueClearFinished: 'queue:clear-finished',
  QueueSetConcurrency: 'queue:set-concurrency',
  QueueGet: 'queue:get',
  QueueDeletePartial: 'queue:delete-partial',
  QueueImport: 'queue:import',

  ArtworkGet: 'artwork:get',
  ArtworkClearCache: 'artwork:clear-cache',

  FsPickDirectory: 'fs:pick-directory',
  FsPickFile: 'fs:pick-file',
  FsReveal: 'fs:reveal',
  FsOpenPath: 'fs:open-path',
  FsExists: 'fs:exists',
  FsStatPackage: 'fs:stat-package',
  ShellOpenExternal: 'shell:open-external',
  ShellCopy: 'shell:copy',

  TasksList: 'tasks:list',
  TasksGet: 'tasks:get',
  TasksClear: 'tasks:clear',
  TasksExport: 'tasks:export',
  TasksCancel: 'tasks:cancel',

  RunRaw: 'run:raw',

  WindowMinimize: 'window:minimize',
  WindowToggleMaximize: 'window:toggle-maximize',
  WindowClose: 'window:close'
  // Frozen at runtime too, not just `as const` at compile time: every process
  // shares this live object, so a compromised renderer must not be able to
  // re-point an innocuous channel name at a sensitive handler.
} as const)

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

/** Actions the UI can request for a single queue item. */
export type QueueAction =
  | 'pause'
  | 'resume'
  | 'cancel'
  | 'retry'
  | 'remove'
  | 'move-up'
  | 'move-down'
  | 'open'
  | 'reveal'
  | 'copy-path'

/** Payloads for the download options dialog. */
export interface EnqueueOptions {
  items: DownloadRequest[]
  /** Start immediately even if the queue is over capacity. */
  priority?: boolean
}

export interface SearchRequest {
  term: string
  limit?: number
  platform?: Platform
}

export interface PurchasesRequest {
  page?: number
  maxResults?: number
  platform?: Platform
}

export interface FileFilter {
  name: string
  extensions: string[]
}

/** Main -> renderer push events. */
export interface EventPayloadMap {
  'engine:status': EngineStatus
  'engine:progress': EngineStatus
  'account:changed': AccountInfo | null
  'settings:changed': Settings
  'task:created': TaskRecord
  'task:log': { taskId: string; line: LogLine }
  'task:finished': TaskRecord
  'queue:snapshot': QueueSnapshot
  'queue:progress': ProgressEvent
  'queue:item-finished': QueueItem
  'system:theme': 'light' | 'dark'
  'window:maximized': boolean
  'update:state': { state: 'idle' | 'checking' | 'available' | 'error'; info: UpdateCheckResult | null }
}

export type EventChannel = keyof EventPayloadMap

/**
 * Everything the renderer is allowed to do. Implemented by the preload script
 * via `contextBridge`; the renderer only ever sees this interface.
 */
export interface RendererApi {
  /* --- meta ------------------------------------------------------- */
  getAppInfo(): Promise<AppInfoPayload>

  /**
   * Subscribes to a main-process event. Returns an unsubscribe function.
   * Listeners are invoked outside React's render cycle; high-frequency channels
   * (`queue:progress`) are already throttled in the main process.
   */
  on<K extends EventChannel>(channel: K, listener: (payload: EventPayloadMap[K]) => void): () => void

  /* --- settings --------------------------------------------------- */
  getSettings(): Promise<Settings>
  updateSettings(patch: Partial<Settings>): Promise<Settings>
  resetSettings(): Promise<Settings>

  /* --- engine ----------------------------------------------------- */
  getEngineStatus(): Promise<EngineStatus>
  detectEngine(force?: boolean): Promise<EngineStatus>
  installEngine(version?: string): Promise<EngineStatus>
  listEngineReleases(): Promise<Operation<EngineRelease[]>>
  uninstallEngine(): Promise<EngineStatus>
  checkAppUpdate(): Promise<UpdateCheckResult>

  /* --- auth ------------------------------------------------------- */
  listProfiles(): Promise<ProfileView[]>
  addProfile(name: string): Promise<ProfileView[]>
  removeProfile(id: string): Promise<{ profiles: ProfileView[]; removedDir: boolean }>
  renameProfile(id: string, name: string): Promise<ProfileView[]>
  setActiveProfile(id: string): Promise<SwitchResult>
  refreshProfileInfo(id: string): Promise<{ profiles: ProfileView[]; account: AccountInfo | null }>
  setProfileStateDir(id: string, dir: string): Promise<ProfileView[]>
  setProfilePassword(id: string, password: string, email: string): Promise<ProfileView[]>
  forgetProfilePassword(id: string): Promise<ProfileView[]>

  login(email: string, password: string, authCode?: string, profileId?: string): Promise<LoginResult>
  getAccount(): Promise<AccountInfo | null>
  refreshAccount(profileId?: string): Promise<AccountInfo | null>
  revoke(): Promise<Operation<{ revoked: boolean }>>

  /* --- store ------------------------------------------------------ */
  search(request: SearchRequest): Promise<Operation<SearchResult>>
  listVersions(selector: AppSelector, platform?: Platform): Promise<Operation<VersionsResult>>
  getVersionMetadata(
    selector: AppSelector,
    externalVersionID: string,
    platform?: Platform
  ): Promise<Operation<VersionMetadata>>
  listPurchases(request?: PurchasesRequest): Promise<Operation<PurchasesResult>>
  purchase(selector: AppSelector, platform?: Platform): Promise<Operation<PurchaseOutcome>>

  /* --- downloads -------------------------------------------------- */
  enqueue(options: EnqueueOptions): Promise<string[]>
  controlQueue(id: string, action: QueueAction): Promise<void>
  clearFinished(): Promise<void>
  setConcurrency(concurrency: number): Promise<void>
  getQueue(): Promise<QueueSnapshot>
  /** Deletes the resumable `.tmp` so the next retry starts from scratch. */
  deletePartial(id: string): Promise<{ deleted: boolean; path: string | null }>
  importQueueFile(): Promise<number>

  /* --- artwork ---------------------------------------------------- */
  /** Returns a data URL, or null when unavailable. Cached on disk by main. */
  getArtwork(appId: number, country?: string): Promise<string | null>
  clearArtworkCache(): Promise<number>

  /* --- filesystem & shell ----------------------------------------- */
  pickDirectory(title?: string, defaultPath?: string): Promise<string | null>
  pickFile(title?: string, filters?: FileFilter[]): Promise<string | null>
  reveal(targetPath: string): Promise<void>
  openPath(targetPath: string): Promise<string>
  exists(targetPath: string): Promise<boolean>
  statPackage(targetPath: string): Promise<{ size: number | null; mtime: number | null }>
  openExternal(url: string): Promise<void>
  copyText(text: string): Promise<void>

  /* --- tasks & logs ----------------------------------------------- */
  listTasks(): Promise<TaskRecord[]>
  getTask(id: string): Promise<TaskRecord | null>
  clearTasks(): Promise<void>
  exportTasks(): Promise<string | null>
  cancelTask(id: string): Promise<void>

  /* --- power user ------------------------------------------------- */
  runRaw(request: RawRunRequest): Promise<Operation<string>>

  /* --- window ----------------------------------------------------- */
  minimize(): void
  toggleMaximize(): void
  close(): void
}

declare global {
  interface Window {
    api: RendererApi
  }
}
