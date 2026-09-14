#!/usr/bin/env node
/**
 * Development runner:
 *   1. bundles main/preload with esbuild in watch mode
 *   2. starts the Vite dev server for the renderer (HMR)
 *   3. launches Electron against the dev server URL
 *
 * Electron restarts whenever the main process bundle changes.
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createRequire } from 'node:module'
import { once } from 'node:events'
import net from 'node:net'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const require = createRequire(import.meta.url)
const electronBin = require('electron')

const VITE_PORT = Number(process.env.VITE_PORT ?? 5173)

function log(tag, msg) {
  console.log(`\x1b[36m[${tag}]\x1b[0m ${msg}`)
}

async function freePort(start) {
  for (let port = start; port < start + 40; port += 1) {
    const ok = await new Promise((resolve) => {
      const server = net.createServer()
      server.once('error', () => resolve(false))
      server.once('listening', () => server.close(() => resolve(true)))
      server.listen(port, '127.0.0.1')
    })
    if (ok) return port
  }
  throw new Error('no free port found')
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

async function main() {
  const port = await freePort(VITE_PORT)
  const devUrl = `http://127.0.0.1:${port}`

  log('main', 'bundling main/preload (watch)')
  const esbuildWatcher = spawn(process.execPath, [path.join(here, 'build-main.mjs'), '--watch'], {
    cwd: root,
    stdio: 'inherit'
  })

  // Give the first bundle a moment to land before starting vite/electron.
  await new Promise((r) => setTimeout(r, 1500))

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
        electronProc.kill('SIGTERM')
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
    try {
      esbuildWatcher.kill('SIGTERM')
      vite.kill('SIGTERM')
      if (electronProc) electronProc.kill('SIGTERM')
    } catch {
      /* ignore */
    }
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
