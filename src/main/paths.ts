/**
 * Locating the ipatool binary.
 *
 * A GUI app launched from Finder / the Start menu inherits a *minimal* PATH
 * (`/usr/bin:/bin:/usr/sbin:/sbin` on macOS), so `which ipatool` fails even when
 * the user has it installed via Homebrew. We therefore probe an explicit list of
 * well-known install locations in addition to PATH, and remember where the
 * binary came from so the UI can explain it.
 */

import { execFile } from 'node:child_process'
import { access, constants as fsConstants } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { app } from 'electron'

export type EngineSource = 'settings' | 'env' | 'path' | 'managed'

export interface ResolvedEngine {
  path: string
  source: EngineSource
}

export function isWindows(): boolean {
  return process.platform === 'win32'
}

export function binaryName(): string {
  return isWindows() ? 'ipatool.exe' : 'ipatool'
}

/** Where we install a managed copy of ipatool. */
export function managedDir(): string {
  return path.join(app.getPath('userData'), 'bin')
}

export function managedBinaryPath(): string {
  return path.join(managedDir(), binaryName())
}

function home(): string {
  return os.homedir()
}

/** Platform-specific directories that commonly hold an ipatool install. */
export function candidateDirs(): string[] {
  if (process.platform === 'darwin') {
    return [
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/usr/bin',
      path.join(home(), '.local/bin'),
      path.join(home(), 'go/bin'),
      path.join(home(), 'bin')
    ]
  }
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA ?? path.join(home(), 'AppData/Local')
    const programFiles = process.env.ProgramFiles ?? 'C:/Program Files'
    const programData = process.env.ProgramData ?? 'C:/ProgramData'
    return [
      path.join(localAppData, 'Programs/ipatool'),
      path.join(localAppData, 'Microsoft/WinGet/Links'),
      path.join(localAppData, 'Microsoft/WinGet/Packages'),
      path.join(home(), 'scoop/shims'),
      path.join(programData, 'chocolatey/bin'),
      path.join(programFiles, 'ipatool'),
      path.join(home(), 'go/bin')
    ]
  }
  return [
    '/usr/local/bin',
    '/usr/bin',
    '/home/linuxbrew/.linuxbrew/bin',
    path.join(home(), '.local/bin'),
    path.join(home(), 'go/bin'),
    path.join(home(), 'bin'),
    '/opt/bin'
  ]
}

/** True when a path exists and is executable by us. */
export async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.R_OK)
    if (isWindows()) {
      // Windows has no executable bit; existence + a known extension is enough.
      return true
    }
    await access(filePath, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

/** Asks the OS to resolve a command on PATH. Returns null when not found. */
export function lookupOnPath(command: string): Promise<string | null> {
  const finder = isWindows() ? 'where' : 'which'
  return new Promise((resolve) => {
    execFile(finder, [command], { windowsHide: true, timeout: 8000 }, (error, stdout) => {
      if (error) {
        resolve(null)
        return
      }
      // `where` can print several matches; take the first executable one.
      const first = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.length > 0)
      resolve(first ?? null)
    })
  })
}

/** Expands `~` and environment variables in a user-supplied path. */
export function expandUserPath(input: string): string {
  let value = input.trim()
  if (value === '') return ''
  if (value === '~') return home()
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    value = path.join(home(), value.slice(2))
  }
  value = value.replace(/%(\w+)%/g, (_match, name: string) => process.env[name] ?? '')
  value = value.replace(/\$(\w+)/g, (_match, name: string) => process.env[name] ?? '')
  return value
}

/**
 * Ordered resolution strategy. The first existing executable wins.
 *
 * @param override - user-configured path from settings (highest priority)
 */
export async function resolveEngine(override?: string): Promise<ResolvedEngine | null> {
  // 1. Explicit user override.
  const expanded = override ? expandUserPath(override) : ''
  if (expanded) {
    // Accept either a directory containing the binary or the binary itself.
    const asFile = expanded
    const asDir = path.join(expanded, binaryName())
    if (await isExecutable(asFile)) return { path: asFile, source: 'settings' }
    if (await isExecutable(asDir)) return { path: asDir, source: 'settings' }
  }

  // 2. Environment variable, for headless/CI setups and power users.
  const fromEnv = process.env.IPATOOL_PATH ? expandUserPath(process.env.IPATOOL_PATH) : ''
  if (fromEnv && (await isExecutable(fromEnv))) return { path: fromEnv, source: 'env' }

  // 3. Our own managed install - preferred over a stale system copy because we
  //    know its version and can update it.
  const managed = managedBinaryPath()
  if (await isExecutable(managed)) return { path: managed, source: 'managed' }

  // 4. PATH.
  const onPath = await lookupOnPath(isWindows() ? 'ipatool.exe' : 'ipatool')
  if (onPath && (await isExecutable(onPath))) return { path: onPath, source: 'path' }

  // 5. Well-known install directories that a GUI process cannot see via PATH.
  for (const dir of candidateDirs()) {
    const candidate = path.join(dir, binaryName())
    if (await isExecutable(candidate)) return { path: candidate, source: 'path' }
  }

  return null
}

/**
 * PATH handed to child processes: the user's PATH plus the directories we know
 * about, so ipatool resolves consistently regardless of how the app was launched.
 */
export function childEnvPath(): string {
  const sep = isWindows() ? ';' : ':'
  const existing = process.env.PATH ?? ''
  const extra = candidateDirs().filter((dir) => !existing.split(sep).includes(dir))
  return [existing, ...extra].filter(Boolean).join(sep)
}
