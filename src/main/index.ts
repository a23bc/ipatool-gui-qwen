/**
 * Main process entry point.
 *
 * Start-up is deliberately ordered so the window appears as early as possible:
 * the UI renders immediately against a "checking…" engine state, and the slow
 * work (resolving/downloading ipatool, refreshing the Apple account) happens
 * after `ready-to-show`. Nothing on the critical path awaits the network.
 */

import { app, BrowserWindow, dialog, nativeTheme } from 'electron'
import { mkdir } from 'node:fs/promises'
import { applySettings, registerEventForwarding, registerIpc } from './ipc'
import { createMainWindow } from './window'
import { settingsStore } from './settings'
import { engineManager } from './engine'
import { migrateLegacyState } from './profiles'
import { downloadQueue } from './queue'
import { ipatoolApi } from './api'
import { taskRegistry } from './tasks'
import type { Settings } from '../shared/types'

let mainWindow: BrowserWindow | null = null
let quitting = false

const gotLock = app.requestSingleInstanceLock()

if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  void bootstrap()
}

async function bootstrap(): Promise<void> {
  await app.whenReady()

  const settings = await settingsStore.load()
  nativeTheme.themeSource = settings.theme
  taskRegistry.setLineCap(settings.maxLogLines)

  // Must happen before any ipatool invocation: see profiles.migrateLegacyState.
  const migration = await migrateLegacyState().catch(() => null)
  if (migration === 'migrated') console.info('[main] migrated legacy ~/.ipatool into the default profile')
  if (migration === 'quarantined') console.info('[main] quarantined stale ~/.ipatool (a session already existed)')

  registerEventForwarding()
  registerIpc()

  // Settings changes made from anywhere (including a second window) must reach
  // the renderer, so subscribe once here.
  settingsStore.on('change', (next: Settings) => applySettings(next))

  mainWindow = createMainWindow()

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // Warn before closing with work in flight - a killed download is resumable,
  // but losing the queue position and the visible error is still surprising.
  mainWindow.on('close', (event) => {
    if (quitting) return
    const busy = downloadQueue.hasActiveDownloads
    if (!busy || !settingsStore.getInternal().confirmCloseWhileDownloading) return
    event.preventDefault()
    void confirmClose(busy)
  })

  app.on('activate', () => {
    // macOS: re-create the window when the dock icon is clicked.
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow()
    } else {
      mainWindow?.show()
    }
  })

  app.on('before-quit', () => {
    quitting = true
    taskRegistry.cancelAll()
    downloadQueue.shutdown()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  // Post-paint start-up work. Kept off the critical path so the first frame is
  // never blocked on a network round-trip.
  void postStartup()
}

async function confirmClose(busy: boolean): Promise<void> {
  if (!mainWindow) return
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    buttons: ['Cancel', 'Stop and quit'],
    defaultId: 0,
    cancelId: 0,
    title: 'Downloads in progress',
    message: busy
      ? 'Downloads are still running. Quit anyway?'
      : 'Quit now?',
    detail:
      'Partial files are kept on disk, and ipatool resumes them with a ranged request, so nothing is lost - the queue just pauses.'
  })
  if (response === 1) {
    quitting = true
    app.quit()
  }
}

/** Engine detection, account refresh and queue restore - all non-blocking. */
async function postStartup(): Promise<void> {
  try {
    await downloadQueue.load()
  } catch {
    /* a corrupt queue file must not stop the app */
  }

  const settings = settingsStore.getInternal()

  try {
    const status = await engineManager.detect(true)
    if (status.state === 'missing' && settings.autoInstallEngine) {
      await engineManager.install(settings.engineVersion)
    }
  } catch {
    /* surfaced through the engine status event */
  }

  // Only worth asking once the engine is actually usable.
  if (engineManager.state.state === 'ready') {
    const account = await ipatoolApi.accountInfoOrNull().catch(() => null)
    mainWindow?.webContents.send('account:changed', account)
  }

  // Make sure the download folder exists so the first enqueue is not slower
  // than the rest.
  if (settings.downloadDir) {
    await mkdir(settings.downloadDir, { recursive: true }).catch(() => {})
  }
}

// A crash in the main process should never leave a zombie renderer behind.
process.on('uncaughtException', (error) => {
  console.error('[main] uncaught exception', error)
  try {
    mainWindow?.webContents.send('task:log', {
      taskId: 'system',
      line: { t: Date.now(), stream: 'system', level: 'error', text: `Uncaught: ${error?.message ?? error}` }
    })
  } catch {
    /* the window may already be gone */
  }
})

process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandled rejection', reason)
})
