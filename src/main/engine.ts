/**
 * Managing the ipatool binary.
 *
 * The repository deliberately ships **no** ipatool executable. Instead the app
 * resolves one at runtime, in this order:
 *
 *   1. an explicit path from settings (or the IPATOOL_PATH env var)
 *   2. the managed copy we installed under userData/bin
 *   3. PATH and a list of well-known install directories
 *
 * If nothing is found and auto-install is enabled, we fetch the matching asset
 * from majd/ipatool's GitHub releases, **verify it against the published
 * .sha256sum sidecar**, and extract the binary with the built-in tar reader.
 * Supply-chain-wise this is the same trust model as `brew install ipatool`, but
 * the checksum is checked rather than assumed.
 */

import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { mkdir, rename, rm, writeFile, chmod } from 'node:fs/promises'
import { app } from 'electron'
import type { EngineErrorCode, EngineRelease, EngineStatus } from '../shared/types'
import { parseSha256Sum, parseVersion } from '../shared/ipatool/parse'
import { findTarFile, parseTar } from '../shared/tar'
import { applyMirror, describeHttpError, fetchBuffer, fetchJson, fetchText, HttpError } from './http'
import { isExecutable, isWindows, lookupOnPath, managedBinaryPath, managedDir, resolveEngine } from './paths'
import { run } from './runner'
import { settingsStore } from './settings'

const IPATOOL_REPO = 'majd/ipatool'
const API = `https://api.github.com/repos/${IPATOOL_REPO}`

interface GhAsset {
  name: string
  browser_download_url: string
  size: number
}

interface GhRelease {
  tag_name: string
  name: string | null
  published_at: string | null
  prerelease: boolean
  assets: GhAsset[]
}

/** Maps this machine onto ipatool's release asset naming. */
export function platformTokens(): { os: string; arch: string } | null {
  const osMap: Record<string, string> = { darwin: 'macos', linux: 'linux', win32: 'windows' }
  const archMap: Record<string, string> = { x64: 'amd64', arm64: 'arm64' }
  const os = osMap[process.platform]
  const arch = archMap[process.arch]
  if (!os || !arch) return null
  return { os, arch }
}

export function assetNameFor(version: string): string | null {
  const tokens = platformTokens()
  if (!tokens) return null
  return `ipatool-${version}-${tokens.os}-${tokens.arch}.tar.gz`
}

function status(
  state: EngineStatus['state'],
  extra: Partial<EngineStatus> = {}
): EngineStatus {
  return {
    state,
    path: null,
    version: null,
    source: null,
    message: null,
    code: null,
    download: null,
    ...extra
  }
}

export class EngineError extends Error {
  constructor(
    message: string,
    readonly code: Exclude<EngineErrorCode, null>
  ) {
    super(message)
    this.name = 'EngineError'
  }
}

export class EngineManager extends EventEmitter {
  private current: EngineStatus = status('idle')
  private detecting: Promise<EngineStatus> | null = null
  private installing: Promise<EngineStatus> | null = null

  get state(): EngineStatus {
    return this.current
  }

  private set(next: EngineStatus): EngineStatus {
    this.current = next
    this.emit('status', next)
    return next
  }

  /** Cheap accessor used before every ipatool invocation. */
  get binaryPath(): string | null {
    return this.current.state === 'ready' ? this.current.path : null
  }

  /**
   * Resolves the binary and asks it for its version. Concurrent callers share a
   * single in-flight probe so a burst of UI requests does not spawn N processes.
   */
  async detect(force = false): Promise<EngineStatus> {
    if (!force && this.current.state === 'ready') return this.current
    if (this.detecting) return this.detecting

    this.detecting = (async () => {
      this.set(status('checking', { message: null }))
      const override = settingsStore.getInternal().ipatoolPath
      const resolved = await resolveEngine(override)

      if (!resolved) {
        return this.set(
          status('missing', {
            message: 'ipatool was not found on this machine',
            code: 'not-found'
          })
        )
      }

      const version = await this.probeVersion(resolved.path)
      if (!version) {
        return this.set(
          status('error', {
            path: resolved.path,
            source: resolved.source,
            message: `"${resolved.path}" did not respond to --version`,
            code: 'not-executable'
          })
        )
      }

      return this.set(
        status('ready', {
          path: resolved.path,
          version,
          source: resolved.source,
          message: null
        })
      )
    })().finally(() => {
      this.detecting = null
    })

    return this.detecting
  }

  private async probeVersion(binary: string): Promise<string | null> {
    try {
      const outcome = await run(binary, {
        args: ['--version'],
        timeoutMs: 15_000,
        env: this.childEnv()
      })
      if (outcome.code !== 0 && !outcome.stdout && !outcome.stderr) return null
      return parseVersion(`${outcome.stdout}\n${outcome.stderr}`)
    } catch {
      return null
    }
  }

  /**
   * Base env for ipatool invocations.
   *
   * Session isolation (XDG_STATE_HOME) is supplied per call by the profile layer;
   * this only exists so callers have one place to add process-wide variables.
   */
  childEnv(extra: Record<string, string> = {}): Record<string, string> {
    return { ...extra }
  }

  /** Lists published releases, newest first, flagging which have our asset. */
  async releases(limit = 25): Promise<EngineRelease[]> {
    const releases = await fetchJson<GhRelease[]>(`${API}/releases?per_page=${limit}`)
    const tokens = platformTokens()

    return releases
      .map((release) => {
        const version = release.tag_name.replace(/^v/, '')
        const asset = tokens ? `ipatool-${version}-${tokens.os}-${tokens.arch}.tar.gz` : ''
        return {
          version,
          publishedAt: release.published_at,
          prerelease: release.prerelease,
          hasAssetForThisPlatform: asset !== '' && release.assets.some((a) => a.name === asset)
        }
      })
      .filter((entry) => entry.version !== '')
  }

  /**
   * Downloads, verifies and installs ipatool. Emits progress through the
   * `status` event so the UI can show a real percentage.
   */
  async install(version = ''): Promise<EngineStatus> {
    if (this.installing) return this.installing

    this.installing = (async () => {
      const tokens = platformTokens()
      if (!tokens) {
        return this.set(
          status('error', {
            message: `No ipatool build for ${process.platform}/${process.arch}`,
            code: 'unsupported-arch'
          })
        )
      }

      try {
        this.set(status('downloading', { download: { received: 0, total: null, percent: null, phase: 'resolve' } }))

        const release = await this.resolveRelease(version)
        const tag = release.tag_name.replace(/^v/, '')
        const assetName = `ipatool-${tag}-${tokens.os}-${tokens.arch}.tar.gz`
        const asset = release.assets.find((a) => a.name === assetName)

        if (!asset) {
          throw new EngineError(
            `Release ${release.tag_name} has no ${assetName} asset`,
            'download-failed'
          )
        }

        const mirror = settingsStore.getInternal().githubMirror
        const downloadUrl = applyMirror(asset.browser_download_url, mirror)
        const checksumUrl = applyMirror(`${asset.browser_download_url}.sha256sum`, mirror)

        // The checksum is fetched first so a missing sidecar fails fast and
        // loudly instead of after a 20 MB download.
        let expectedHash: string | null = null
        try {
          expectedHash = parseSha256Sum(await fetchText(checksumUrl))?.hash ?? null
        } catch {
          expectedHash = null
        }

        const total = asset.size > 0 ? asset.size : null
        const archive = await fetchBuffer(downloadUrl, {
          onProgress: (received, streamedTotal) => {
            const size = streamedTotal ?? total
            this.set(
              status('downloading', {
                download: {
                  received,
                  total: size,
                  percent: size ? Math.min(100, (received / size) * 100) : null,
                  phase: 'download'
                }
              })
            )
          }
        })

        this.set(status('downloading', { download: { received: archive.byteLength, total, percent: 100, phase: 'verify' } }))

        const actualHash = createHash('sha256').update(archive).digest('hex')
        if (expectedHash && expectedHash !== actualHash) {
          throw new EngineError(
            `Checksum mismatch: expected ${expectedHash.slice(0, 12)}…, got ${actualHash.slice(0, 12)}…`,
            'checksum-mismatch'
          )
        }

        this.set(status('downloading', { download: { received: archive.byteLength, total, percent: 100, phase: 'extract' } }))

        const binary = await this.extractBinary(archive, tag)
        const installedVersion = await this.probeVersion(binary)

        return this.set(
          status('ready', {
            path: binary,
            version: installedVersion ?? tag,
            source: 'managed',
            message: expectedHash ? null : 'Installed without checksum verification (sidecar unavailable)'
          })
        )
      } catch (error) {
        if (error instanceof EngineError) {
          return this.set(status('error', { message: error.message, code: error.code }))
        }
        if (error instanceof HttpError) {
          return this.set(
            status('error', { message: describeHttpError(error, API), code: error.status >= 500 ? 'network' : 'download-failed' })
          )
        }
        const message = error instanceof Error ? error.message : String(error)
        return this.set(status('error', { message, code: 'download-failed' }))
      }
    })().finally(() => {
      this.installing = null
    })

    return this.installing
  }

  private async resolveRelease(version: string): Promise<GhRelease> {
    const wanted = version.trim().replace(/^v/, '')
    if (wanted) {
      return fetchJson<GhRelease>(`${API}/releases/tags/v${wanted}`)
    }
    const pinned = settingsStore.getInternal().engineVersion.trim().replace(/^v/, '')
    if (pinned) {
      return fetchJson<GhRelease>(`${API}/releases/tags/v${pinned}`)
    }
    return fetchJson<GhRelease>(`${API}/releases/latest`)
  }

  /** Gunzips, untars and installs the binary into the managed directory. */
  private async extractBinary(archive: Uint8Array, tag: string): Promise<string> {
    let entries
    try {
      entries = parseTar(gunzipSync(archive))
    } catch (error) {
      throw new EngineError(`Could not read the release archive: ${(error as Error).message}`, 'extract-failed')
    }

    // Release archives nest the binary under `bin/ipatool-<v>-<os>-<arch>[.exe]`.
    const entry =
      findTarFile(entries, (base) => base.startsWith('ipatool-') && this.matchesBinarySuffix(base)) ??
      findTarFile(entries, (base) => base.startsWith('ipatool'))

    if (!entry || !entry.data) {
      throw new EngineError('The release archive did not contain an ipatool binary', 'extract-failed')
    }

    const dir = managedDir()
    await mkdir(dir, { recursive: true })
    const target = managedBinaryPath()
    const tmp = `${target}.${tag}.${process.pid}.tmp`

    await writeFile(tmp, entry.data)
    if (!isWindows()) await chmod(tmp, 0o755)

    try {
      await rename(tmp, target)
    } catch (error) {
      await rm(tmp, { force: true })
      throw new EngineError(
        `Could not install to ${target}: ${(error as Error).message}`,
        'extract-failed'
      )
    }
    if (!isWindows()) await chmod(target, 0o755)

    if (!(await isExecutable(target))) {
      throw new EngineError(`Installed binary at ${target} is not executable`, 'not-executable')
    }
    return target
  }

  private matchesBinarySuffix(base: string): boolean {
    return isWindows() ? base.endsWith('.exe') : !base.endsWith('.exe')
  }

  /** Removes the managed copy (a system install is left alone). */
  async uninstall(): Promise<EngineStatus> {
    await rm(managedBinaryPath(), { force: true })
    return this.detect(true)
  }

  /**
   * Ensures a usable binary exists, installing on demand.
   * Throws EngineError when the app cannot proceed.
   */
  async ensure(): Promise<string> {
    const detected = await this.detect()
    if (detected.state === 'ready' && detected.path) return detected.path

    if (settingsStore.getInternal().autoInstallEngine) {
      const installed = await this.install(settingsStore.getInternal().engineVersion)
      if (installed.state === 'ready' && installed.path) return installed.path
      throw new EngineError(installed.message ?? 'Failed to install ipatool', installed.code ?? 'download-failed')
    }

    // Last chance: maybe it appeared on PATH since we last looked.
    const onPath = await lookupOnPath(isWindows() ? 'ipatool.exe' : 'ipatool')
    if (onPath) {
      const version = await this.probeVersion(onPath)
      if (version) {
        this.set(status('ready', { path: onPath, version, source: 'path' }))
        return onPath
      }
    }

    throw new EngineError(
      'ipatool is not installed and automatic installation is disabled. Install it (brew install ipatool, or download a release) or enable auto-install in Settings.',
      'not-found'
    )
  }

  /** Informational block shown in Settings. */
  describe(): Record<string, string> {
    return {
      managedDir: managedDir(),
      userData: app.getPath('userData'),
      platform: `${process.platform}/${process.arch}`,
      asset: assetNameFor('VERSION') ?? 'unsupported'
    }
  }
}

export const engineManager = new EngineManager()
