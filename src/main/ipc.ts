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
  Settings
} from '../shared/types'
import type { ProfileView } from '../shared/ipc'
import { IPC } from '../shared/ipc'
import { quoteCommand } from '../shared/format'
import { redactArgs } from '../shared/redact'
import { parseImportList } from '../shared/import'
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

function mainWindow(): BrowserWindow | null {
  const windows = BrowserWindow.getAllWindows()
  return windows.length > 0 ? windows[0] : null
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
    // Direct mutation through the settings store keeps one persistence path.
    const next = profiles.list().map((p) => (p.id === id ? { ...p, stateDir: String(dir ?? '') } : p))
    settingsStore.override({ ...settingsStore.getInternal(), profiles: next })
    void settingsStore.persistNow()
    settingsStore.emitChange()
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

  ipcMain.handle(IPC.QueueControl, (_e, id: string, action: string) => downloadQueue.control(String(id), String(action)))

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

  ipcMain.handle(IPC.FsOpenPath, (_e, target: string) => shell.openPath(String(target ?? '')))

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

  ipcMain.handle(IPC.RunRaw, (_e, request: { args: string[]; interactive?: boolean }) => {
    const args = Array.isArray(request?.args) ? request.args.map(String) : []
    if (args.length === 0) {
      return Promise.resolve({
        ok: false as const,
        error: 'No arguments given',
        hint: null,
        code: 'bad-request',
        taskId: '',
        exitCode: null
      })
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
  const views: ProfileView[] = []
  for (const profile of profiles.list()) {
    views.push({
      ...profile,
      active: profile.id === activeId,
      dir: profiles.dirFor(profile),
      hasPassword: await credentials.has(profile.id)
    })
  }
  return views
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

/** Extracted so the notification body stays testable. */
export function notificationBody(item: QueueItem): string {
  if (item.state === 'done') return `${item.name} finished downloading`
  return `${item.name} failed: ${item.error?.message ?? 'unknown error'}`
}

/** Preview of the command the raw console is about to run. */
export function previewRawCommand(args: string[]): string {
  return `ipatool ${quoteCommand(redactArgs(args))}`
}
