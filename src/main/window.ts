/**
 * Window creation and lifecycle.
 *
 * Security posture follows Electron's checklist: the renderer is sandboxed, node
 * integration is off, context isolation is on, navigation and new windows are
 * blocked, and the page ships a CSP. The preload exposes a single frozen API
 * object - the renderer can never reach `ipcRenderer` directly.
 */

import path from 'node:path'
import { BrowserWindow, nativeTheme, shell } from 'electron'
import { APP_PRODUCT } from './update'

const DEV_URL = process.env.IPATOOL_GUI_DEV_URL

export interface WindowOptions {
  width?: number
  height?: number
}

function titleBarOptions(): Electron.BrowserWindowConstructorOptions {
  if (process.platform === 'darwin') {
    // Native traffic lights, no bar - the standard macOS look.
    return { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 18 } }
  }
  if (process.platform === 'win32') {
    // OS-drawn caption buttons over our own header, themed to match.
    const dark = nativeTheme.shouldUseDarkColors
    return {
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        color: dark ? '#101014' : '#ffffff',
        symbolColor: dark ? '#c9c9d1' : '#3a3a42',
        height: 36
      }
    }
  }
  // Linux window managers vary too much for a custom titlebar to be reliable.
  return {}
}

export function createMainWindow(options: WindowOptions = {}): BrowserWindow {
  const dark = nativeTheme.shouldUseDarkColors

  const win = new BrowserWindow({
    width: options.width ?? 1240,
    height: options.height ?? 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: dark ? '#0b0b0f' : '#f7f7f9',
    title: APP_PRODUCT,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      // Downloads render at 10 Hz; throttling a backgrounded window would make
      // the progress bar stutter when the user switches apps.
      backgroundThrottling: false,
      spellcheck: false,
      devTools: true
    },
    ...titleBarOptions()
  })

  // Anything the page tries to open goes to the real browser, never to a new
  // Electron window we do not control.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  win.webContents.on('will-navigate', (event, url) => {
    const allowed = DEV_URL ? url.startsWith(DEV_URL) : url.startsWith('file://')
    if (!allowed) {
      event.preventDefault()
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    }
  })

  // Paint only once the renderer has produced its first frame, so the window
  // never flashes white/black on launch.
  win.once('ready-to-show', () => {
    win.show()
    win.focus()
  })

  win.on('maximize', () => win.webContents.send('window:maximized', true))
  win.on('unmaximize', () => win.webContents.send('window:maximized', false))

  if (DEV_URL) {
    void win.loadURL(DEV_URL)
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  return win
}

/** Keeps the Windows caption buttons in sync with the app theme. */
export function syncTitleBarOverlay(win: BrowserWindow | null): void {
  if (!win || process.platform !== 'win32') return
  try {
    const dark = nativeTheme.shouldUseDarkColors
    win.setTitleBarOverlay({
      color: dark ? '#101014' : '#ffffff',
      symbolColor: dark ? '#c9c9d1' : '#3a3a42',
      height: 36
    })
  } catch {
    /* older Electron builds without overlay support */
  }
}
