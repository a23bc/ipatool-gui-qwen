#!/usr/bin/env node
/**
 * Development runner:
 *   1. bundles main/preload with esbuild in watch mode
 *   2. starts the Vite dev server for the renderer (HMR)
 *   3. launches Electron against the dev server URL
 *
 * Electron restarts whenever the main process bundle changes.
 *
 * The dev server port is FIXED (default 5173). It used to be probed for a free
 * port, but src/renderer/index.html's CSP hardcodes ws://127.0.0.1:5173 for
 * HMR - silently landing on 5174 left the renderer with a CSP that blocked
 * every dev-server connection (blank window, no hot reload). If the port is
 * taken we now fail loudly instead; change the constant *and* the CSP together
 * if it must move.
 */
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createRequire } from 'node:module'
import { once } from 'node:events'
import net from 'node:net'
import { access } from 'node:fs/promises'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const require = createRequire(import.meta.url)
const electronBin = require('electron')

const VITE_PORT = Number(process.env.VITE_PORT ?? 5173)

function log(tag, msg) {
  console.log(`\x1b[36m[${tag}]\x1b[0m ${msg}`)
}

function isPortInUse(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(true))
    server.once('listening', () => server.close(() => resolve(false)))
    server.listen(port, '127.0.0.1')
  })
}

async function waitForServer(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok || res.status === 404) return
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`vite dev server did not come up at ${url}`)
}

/** Polls until a file exists (esbuild's first bundle landing on disk). */
async function waitForFile(file, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await access(file)
      return
    } catch {
      await new Promise((r) => setTimeout(r, 200))
    }
  }
  throw new Error(`timed out waiting for ${file}`)
}

/**
 * Kills a child (and on Windows its whole process tree).
 *
 * Windows has no SIGTERM: Node emulates it with an unconditional terminate
 * that does NOT reach grand-children (Electron's GPU/renderer helpers), which
 * is how ghost processes survived every dev session and kept 5173 occupied.
 * `taskkill /F /T` kills the tree; POSIX gets SIGTERM with a SIGKILL escalation.
 */
function killChild(child) {
  if (!child || child.killed || child.pid === undefined) return
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' })
    } catch {
      try {
        child.kill()
      } catch {
        /* nothing else to try */
      }
    }
    return
  }
  try {
    child.kill('SIGTERM')
  } catch {
    return
  }
  const escalate = setTimeout(() => {
    try {
      child.kill('SIGKILL')
    } catch {
      /* already gone */
    }
  }, 2500)
  escalate.unref?.()
}

async function main() {
  if (VITE_PORT !== 5173) {
    log(
      'main',
      `WARNING: VITE_PORT=${VITE_PORT} but the CSP in src/renderer/index.html only allows 5173 - HMR will be blocked unless you update it too`
    )
  }
  if (await isPortInUse(VITE_PORT)) {
    console.error(
      `Port ${VITE_PORT} is in use. The renderer CSP hardcodes this port for ws:// and http://, ` +
        'so we cannot silently move to another one. Free the port, or change VITE_PORT *and* the CSP together.'
    )
    process.exit(1)
  }
  const port = VITE_PORT
  const devUrl = `http://127.0.0.1:${port}`

  log('main', 'bundling main/preload (watch)')
  const esbuildWatcher = spawn(process.execPath, [path.join(here, 'build-main.mjs'), '--watch'], {
    cwd: root,
    stdio: 'inherit'
  })

  // Wait for the first bundle to actually land instead of sleeping a fixed
  // 1.5 s (too short on cold/slow machines, wasted time on fast ones).
  await waitForFile(path.join(root, 'dist/main/index.js'))
  await waitForFile(path.join(root, 'dist/preload/index.js'))

  log('renderer', `starting vite on ${devUrl}`)
  const vite = spawn(
    process.execPath,
    [path.join(root, 'node_modules/vite/bin/vite.js'), '--port', String(port), '--strictPort'],
    { cwd: root, stdio: 'inherit', env: { ...process.env, BROWSER: 'none' } }
  )

  await waitForServer(devUrl)

  let electronProc = null
  let restarting = false

  const startElectron = () => {
    if (electronProc && !electronProc.killed) return
    log('electron', 'launching')
    electronProc = spawn(electronBin, ['.', '--remote-debugging-port=0'], {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, IPATOOL_GUI_DEV_URL: devUrl, NODE_ENV: 'development' }
    })
    electronProc.on('exit', (code) => {
      if (!restarting) {
        log('electron', `exited (${code})`)
        shutdown(0)
      }
      electronProc = null
    })
  }

  startElectron()

  // Restart electron when the main bundle is rewritten.
  const { watch } = await import('node:fs')
  let debounce = null
  const mainOut = path.join(root, 'dist/main/index.js')
  try {
    const watcher = watch(path.dirname(mainOut))
    watcher.on('change', () => {
      clearTimeout(debounce)
      debounce = setTimeout(() => {
        if (!electronProc) return
        restarting = true
        log('electron', 'main bundle changed → restarting')
        killChild(electronProc)
        setTimeout(() => {
          restarting = false
          startElectron()
        }, 400)
      }, 400)
    })
  } catch (error) {
    log('watch', `could not watch main bundle: ${error.message}`)
  }

  const shutdown = (code) => {
    killChild(esbuildWatcher)
    killChild(vite)
    killChild(electronProc)
    process.exit(code)
  }

  process.on('SIGINT', () => shutdown(0))
  process.on('SIGTERM', () => shutdown(0))
  await once(process, 'exit')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
