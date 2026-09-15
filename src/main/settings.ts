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
      this.persist().catch((error: unknown) => {
        console.warn('[settings] save failed:', error instanceof Error ? error.message : String(error))
      })
      this.emit('change', this.get())
    }
    return this.get()
  }

  reset(): Settings {
    this.settings = defaultSettings()
    this.persist().catch((error: unknown) => {
      console.warn('[settings] save failed:', error instanceof Error ? error.message : String(error))
    })
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
      try {
        await this.persist()
        return generated
      } catch (error) {
        // The passphrase could not be encrypted (no libsecret/kwallet): degrade
        // loudly to passphraseMode=none instead of leaving it in memory or -
        // worse - writing it to disk in cleartext.
        console.warn(
          '[settings] cannot protect the generated keychain passphrase; falling back to passphraseMode=none:',
          error instanceof Error ? error.message : String(error)
        )
        this.settings.passphraseMode = 'none'
        this.settings.keychainPassphrase = ''
        await this.persist().catch(() => {})
        this.emit('change', this.get())
        return ''
      }
    }
    return ''
  }

  /** Public flush used by the profile store after bypassing update(). */
  persistNow(): Promise<void> {
    return this.persist()
  }

  /** Notifies listeners without touching values (used by the profile store). */
  emitChange(): void {
    this.emit('change', this.get())
  }

  /**
   * Serialises writes so concurrent updates cannot interleave.
   *
   * The returned promise rejects when the save fails (so `effectivePassphrase`
   * can react to a refused encryption), while the internal chain swallows the
   * error so one failed write can never wedge subsequent ones.
   */
  private persist(): Promise<void> {
    const write = this.writeChain.then(async () => {
      const payload: Settings = {
        ...this.settings,
        keychainPassphrase: this.encryptSecret(this.settings.keychainPassphrase)
      }
      await mkdir(path.dirname(this.file), { recursive: true })
      const tmp = `${this.file}.${process.pid}.tmp`
      await writeFile(tmp, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 })
      await rename(tmp, this.file)
    })
    this.writeChain = write.catch(() => {
      /* a failed save must never crash the app */
    })
    return write
  }

  /**
   * Encrypts a secret for disk. Throws when encryption is unavailable:
   * silently falling back to a `plain:` value would write the keychain
   * passphrase - the key to ipatool's keyring, which holds the Apple session -
   * into settings.json in cleartext, defeating the module's core promise.
   * `plain:` values are still *read* (decryptSecret) so an existing install is
   * not locked out, but they are never written again.
   */
  private encryptSecret(value: string): string {
    if (!value) return ''
    if (!this.encryptionAvailable()) {
      throw new Error(
        'Refusing to persist the keychain passphrase: safeStorage encryption is unavailable ' +
          '(on Linux install libsecret / gnome-keyring, or set passphraseMode to "none")'
      )
    }
    return ENCRYPTED_PREFIX + safeStorage.encryptString(value).toString('base64')
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
