/**
 * Preload bridge.
 *
 * Runs in a sandboxed, context-isolated world. The renderer never sees
 * `ipcRenderer` - it only gets this typed object, which is the single choke
 * point for everything the UI is allowed to ask the main process to do. That
 * keeps the attack surface to an explicit allow-list instead of "whatever a
 * compromised page can invoke".
 */

import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC,
  type EventChannel,
  type EventPayloadMap,
  type FileFilter,
  type ProfileView,
  type RendererApi
} from '../shared/ipc'
import type {
  AccountInfo,
  AppInfoPayload,
  DownloadRequest,
  EngineRelease,
  EngineStatus,
  LoginResult,
  Operation,
  Platform,
  PurchasesResult,
  QueueSnapshot,
  PurchaseOutcome,
  SearchResult,
  Settings,
  TaskRecord,
  UpdateCheckResult,
  VersionMetadata,
  VersionsResult
} from '../shared/types'
import type { AppSelector } from '../shared/ipatool/args'
import type { QueueAction, SearchRequest, PurchasesRequest, EnqueueOptions } from '../shared/ipc'

const api: RendererApi = {
  getAppInfo: (): Promise<AppInfoPayload> => ipcRenderer.invoke(IPC.AppInfo),

  on<K extends EventChannel>(channel: K, listener: (payload: EventPayloadMap[K]) => void): () => void {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: EventPayloadMap[K]): void => {
      try {
        listener(payload)
      } catch (error) {
        // A throwing listener must never break the IPC dispatch loop.
        console.error(`[renderer] listener for "${channel}" threw`, error)
      }
    }
    ipcRenderer.on(channel, wrapped)
    return () => {
      ipcRenderer.removeListener(channel, wrapped)
    }
  },

  getSettings: (): Promise<Settings> => ipcRenderer.invoke(IPC.SettingsGet),
  updateSettings: (patch: Partial<Settings>): Promise<Settings> =>
    ipcRenderer.invoke(IPC.SettingsUpdate, patch),
  resetSettings: (): Promise<Settings> => ipcRenderer.invoke(IPC.SettingsReset),

  getEngineStatus: (): Promise<EngineStatus> => ipcRenderer.invoke(IPC.EngineStatus),
  detectEngine: (force?: boolean): Promise<EngineStatus> => ipcRenderer.invoke(IPC.EngineDetect, force),
  installEngine: (version?: string): Promise<EngineStatus> => ipcRenderer.invoke(IPC.EngineInstall, version),
  listEngineReleases: (): Promise<Operation<EngineRelease[]>> => ipcRenderer.invoke(IPC.EngineReleases),
  uninstallEngine: (): Promise<EngineStatus> => ipcRenderer.invoke(IPC.EngineUninstall),
  checkAppUpdate: (): Promise<UpdateCheckResult> => ipcRenderer.invoke(IPC.AppCheckUpdate),

  listProfiles: (): Promise<ProfileView[]> => ipcRenderer.invoke(IPC.ProfilesList),
  addProfile: (name: string): Promise<ProfileView[]> => ipcRenderer.invoke(IPC.ProfilesAdd, name),
  removeProfile: (id: string): Promise<{ profiles: ProfileView[]; removedDir: boolean }> =>
    ipcRenderer.invoke(IPC.ProfilesRemove, id),
  renameProfile: (id: string, name: string): Promise<ProfileView[]> =>
    ipcRenderer.invoke(IPC.ProfilesRename, id, name),
  setActiveProfile: (id: string): Promise<{ profiles: ProfileView[]; account: AccountInfo | null }> =>
    ipcRenderer.invoke(IPC.ProfilesSetActive, id),
  refreshProfileInfo: (id: string): Promise<{ profiles: ProfileView[]; account: AccountInfo | null }> =>
    ipcRenderer.invoke(IPC.ProfilesRefreshInfo, id),
  setProfileStateDir: (id: string, dir: string): Promise<ProfileView[]> =>
    ipcRenderer.invoke(IPC.ProfilesSetStateDir, id, dir),

  login: (email: string, password: string, authCode?: string, profileId?: string): Promise<LoginResult> =>
    ipcRenderer.invoke(IPC.AuthLogin, email, password, authCode, profileId),
  getAccount: (): Promise<AccountInfo | null> => ipcRenderer.invoke(IPC.AuthAccount),
  refreshAccount: (profileId?: string): Promise<AccountInfo | null> =>
    ipcRenderer.invoke(IPC.AuthRefresh, profileId),
  revoke: (): Promise<Operation<{ revoked: boolean }>> => ipcRenderer.invoke(IPC.AuthRevoke),

  search: (request: SearchRequest): Promise<Operation<SearchResult>> =>
    ipcRenderer.invoke(IPC.StoreSearch, request),
  listVersions: (selector: AppSelector, platform?: Platform): Promise<Operation<VersionsResult>> =>
    ipcRenderer.invoke(IPC.StoreVersions, selector, platform),
  getVersionMetadata: (
    selector: AppSelector,
    externalVersionID: string,
    platform?: Platform
  ): Promise<Operation<VersionMetadata>> =>
    ipcRenderer.invoke(IPC.StoreVersionMetadata, selector, externalVersionID, platform),
  listPurchases: (request?: PurchasesRequest): Promise<Operation<PurchasesResult>> =>
    ipcRenderer.invoke(IPC.StorePurchases, request ?? {}),
  purchase: (selector: AppSelector, platform?: Platform): Promise<Operation<PurchaseOutcome>> =>
    ipcRenderer.invoke(IPC.StorePurchase, selector, platform),

  enqueue: (options: EnqueueOptions): Promise<string[]> => ipcRenderer.invoke(IPC.QueueEnqueue, options),
  controlQueue: (id: string, action: QueueAction): Promise<void> =>
    ipcRenderer.invoke(IPC.QueueControl, id, action),
  clearFinished: (): Promise<void> => ipcRenderer.invoke(IPC.QueueClearFinished),
  setConcurrency: (concurrency: number): Promise<void> =>
    ipcRenderer.invoke(IPC.QueueSetConcurrency, concurrency),
  getQueue: (): Promise<QueueSnapshot> => ipcRenderer.invoke(IPC.QueueGet),
  deletePartial: (id: string): Promise<{ deleted: boolean; path: string | null }> =>
    ipcRenderer.invoke(IPC.QueueDeletePartial, id),
  importQueueFile: (): Promise<number> => ipcRenderer.invoke(IPC.QueueImport),

  getArtwork: (appId: number, country?: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC.ArtworkGet, appId, country),
  clearArtworkCache: (): Promise<number> => ipcRenderer.invoke(IPC.ArtworkClearCache),

  pickDirectory: (title?: string, defaultPath?: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC.FsPickDirectory, title, defaultPath),
  pickFile: (title?: string, filters?: FileFilter[]): Promise<string | null> =>
    ipcRenderer.invoke(IPC.FsPickFile, title, filters),
  reveal: (targetPath: string): Promise<void> => ipcRenderer.invoke(IPC.FsReveal, targetPath),
  openPath: (targetPath: string): Promise<string> => ipcRenderer.invoke(IPC.FsOpenPath, targetPath),
  exists: (targetPath: string): Promise<boolean> => ipcRenderer.invoke(IPC.FsExists, targetPath),
  statPackage: (targetPath: string): Promise<{ size: number | null; mtime: number | null }> =>
    ipcRenderer.invoke(IPC.FsStatPackage, targetPath),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke(IPC.ShellOpenExternal, url),
  copyText: (text: string): Promise<void> => ipcRenderer.invoke(IPC.ShellCopy, text),

  listTasks: (): Promise<TaskRecord[]> => ipcRenderer.invoke(IPC.TasksList),
  getTask: (id: string): Promise<TaskRecord | null> => ipcRenderer.invoke(IPC.TasksGet, id),
  clearTasks: (): Promise<void> => ipcRenderer.invoke(IPC.TasksClear),
  exportTasks: (): Promise<string | null> => ipcRenderer.invoke(IPC.TasksExport),
  cancelTask: (id: string): Promise<void> => ipcRenderer.invoke(IPC.TasksCancel, id),

  runRaw: (request: { args: string[]; interactive?: boolean }): Promise<Operation<string>> =>
    ipcRenderer.invoke(IPC.RunRaw, request),

  minimize: (): void => {
    ipcRenderer.send(IPC.WindowMinimize)
  },
  toggleMaximize: (): void => {
    ipcRenderer.send(IPC.WindowToggleMaximize)
  },
  close: (): void => {
    ipcRenderer.send(IPC.WindowClose)
  }
}

// Expose as a frozen object so page scripts cannot monkey-patch the bridge.
contextBridge.exposeInMainWorld('api', Object.freeze(api))

// Typed convenience re-exports for the renderer's `DownloadRequest` usage.
export type { DownloadRequest }
