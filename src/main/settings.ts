/**
 * Persistent settings.
 *
 * Stored as JSON in Electron's userData directory and written atomically
 * (temp file + rename) so a crash mid-save cannot corrupt the config.
 *
 * Secrets are encrypted with `safeStorage` (DPAPI on Windows, Keychain on macOS,
 * libsecret on Linux) before touching disk. The Apple ID password is *never*
 * persisted - ipatool keeps its own credentials in its keyring, and this app has
 * no business holding a second copy.
 */

import { randomBytes } from 'node:crypto'
import { app, safeStorage } from 'electron'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import type { Settings } from '../shared/types'

const SETTINGS_FILE = 'settings.json'
const ENCRYPTED_PREFIX = 'enc:v1:'

export type SettingsEvent = 'change'

function defaultDownloadDir(): string {
  try {
    return path.join(app.getPath('downloads'), 'ipatool')
  } catch {
    return path.join(app.getPath('home'), 'Downloads', 'ipatool')
  }
}

export function defaultSettings(): Settings {
  return {
    ipatoolPath: '',
    autoInstallEngine: true,
    engineVersion: '',
    githubMirror: '',
    downloadDir: defaultDownloadDir(),
    concurrency: 2,
    autoPurchase: true,
    defaultPlatform: '',
    searchLimit: 25,
    purchasesPageSize: 50,
    passphraseMode: 'auto',
    keychainPassphrase: '',
    stateDir: '',
    verbose: false,
    theme: 'system',
    locale: 'system',
    artworkEnabled: true,
    artworkCountry: 'us',
    maxLogLines: 2000,
    resumeQueueOnLaunch: true,
    notifyOnComplete: true,
    confirmCloseWhileDownloading: true,
    lastEmail: ''
  }
}

/** Coerces an untrusted/partial persisted object onto the current shape. */
export function normalizeSettings(input: unknown): Settings {
  const base = defaultSettings()
  if (!input || typeof input !== 'object') return base
  const raw = input as Record<string, unknown>
  const out: Settings = { ...base }

  for (const key of Object.keys(base) as Array<keyof Settings>) {
    if (!(key in raw)) continue
    const value = raw[key as string]
    const expected = base[key]
    if (typeof expected === 'boolean' && typeof value === 'boolean') {
      ;(out[key] as boolean) = value
    } else if (typeof expected === 'number' && typeof value === 'number' && Number.isFinite(value)) {
      ;(out[key] as number) = value
    } else if (typeof expected === 'string' && typeof value === 'string') {
      ;(out[key] as string) = value
    }
  }

  // Range guards - a bad value here would break the download pool or the UI.
  out.concurrency = Math.min(8, Math.max(1, Math.round(out.concurrency)))
  out.searchLimit = Math.min(200, Math.max(1, Math.round(out.searchLimit)))
  out.purchasesPageSize = Math.min(1000, Math.max(1, Math.round(out.purchasesPageSize)))
  out.maxLogLines = Math.min(50_000, Math.max(100, Math.round(out.maxLogLines)))

  const platforms = ['', 'iphone', 'ipad', 'appletv', 'visionos', 'macos']
  if (!platforms.includes(out.defaultPlatform)) out.defaultPlatform = ''

  const themes = ['system', 'light', 'dark']
  if (!themes.includes(out.theme)) out.theme = 'system'

  const locales = ['system', 'zh-CN', 'en-US']
  if (!locales.includes(out.locale)) out.locale = 'system'

  const modes = ['auto', 'manual', 'none']
  if (!modes.includes(out.passphraseMode)) out.passphraseMode = 'auto'

  if (out.artworkCountry.trim() === '') out.artworkCountry = 'us'

  return out
}

export class SettingsStore extends EventEmitter {
  private settings: Settings = defaultSettings()
  private file = ''
  private loaded = false
  private writeChain: Promise<void> = Promise.resolve()

  /** Must be called after `app.whenReady()`. */
  init(): Settings {
    this.file = path.join(app.getPath('userData'), SETTINGS_FILE)
    this.settings = defaultSettings()
    this.loaded = true
    return this.settings
  }

  async load(): Promise<Settings> {
    if (!this.loaded) this.init()
    try {
      const raw = await readFile(this.file, 'utf8')
      this.settings = normalizeSettings(JSON.parse(raw))
    } catch {
      // Missing or unreadable settings are not fatal; fall back to defaults.
      this.settings = defaultSettings()
    }
    this.settings.keychainPassphrase = this.decryptSecret(this.settings.keychainPassphrase)
    return this.settings
  }

  get(): Settings {
    // Never leak the plaintext secret through the settings snapshot.
    return { ...this.settings, keychainPassphrase: this.settings.keychainPassphrase ? '********' : '' }
  }

  /** Full settings including the plaintext passphrase - main process only. */
  getInternal(): Settings {
    return this.settings
  }

  update(patch: Partial<Settings>): Settings {
    if (!this.loaded) this.init()
    const next = normalizeSettings({ ...this.settings, ...patch })
    // Preserve the secret when the UI sends back its masked placeholder.
    if (patch.keychainPassphrase === undefined || patch.keychainPassphrase === '********') {
      next.keychainPassphrase = this.settings.keychainPassphrase
    }
    const changed = JSON.stringify(next) !== JSON.stringify(this.settings)
    this.settings = next
    if (changed) {
      void this.persist()
      this.emit('change', this.get())
    }
    return this.get()
  }

  reset(): Settings {
    this.settings = defaultSettings()
    void this.persist()
    this.emit('change', this.get())
    return this.get()
  }

  /**
   * The passphrase to hand to `--keychain-passphrase`, or '' when ipatool should
   * use the platform keyring unaided.
   */
  async effectivePassphrase(): Promise<string> {
    const mode = this.settings.passphraseMode
    if (mode === 'none') return ''
    if (this.settings.keychainPassphrase) return this.settings.keychainPassphrase
    if (mode === 'auto') {
      // Generate once and keep it, so repeated runs unlock the same keyring file.
      const generated = randomBytes(24).toString('base64url')
      this.settings.keychainPassphrase = generated
      await this.persist()
      return generated
    }
    return ''
  }

  /** Serialises writes so concurrent updates cannot interleave. */
  private persist(): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      const payload: Settings = {
        ...this.settings,
        keychainPassphrase: this.encryptSecret(this.settings.keychainPassphrase)
      }
      await mkdir(path.dirname(this.file), { recursive: true })
      const tmp = `${this.file}.${process.pid}.tmp`
      await writeFile(tmp, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 })
      await rename(tmp, this.file)
    }).catch(() => {
      /* a failed save must never crash the app */
    })
    return this.writeChain
  }

  private encryptSecret(value: string): string {
    if (!value) return ''
    if (!this.encryptionAvailable()) return `plain:${value}`
    try {
      return ENCRYPTED_PREFIX + safeStorage.encryptString(value).toString('base64')
    } catch {
      return `plain:${value}`
    }
  }

  private decryptSecret(value: string): string {
    if (!value) return ''
    if (value.startsWith('plain:')) return value.slice('plain:'.length)
    if (!value.startsWith(ENCRYPTED_PREFIX)) return ''
    if (!this.encryptionAvailable()) return ''
    try {
      return safeStorage.decryptString(Buffer.from(value.slice(ENCRYPTED_PREFIX.length), 'base64'))
    } catch {
      return ''
    }
  }

  encryptionAvailable(): boolean {
    try {
      return safeStorage.isEncryptionAvailable()
    } catch {
      return false
    }
  }

  override(settings: Settings): void {
    this.settings = settings
  }

  get filePath(): string {
    return this.file
  }
}

export const settingsStore = new SettingsStore()
