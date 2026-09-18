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
import type { AccountProfile, CredentialStore, Settings } from '../shared/types'

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
    isolateSessionHome: true,
    accounts: [],
    activeAccountId: '',
    accountCounter: 1,
    verbose: false,
    theme: 'system',
    locale: 'system',
    artworkEnabled: true,
    artworkCountry: 'us',
    maxLogLines: 2000,
    resumeQueueOnLaunch: true,
    notifyOnComplete: true,
    confirmCloseWhileDownloading: false,
    lastEmail: ''
  }
}

const CREDENTIAL_STORES: readonly CredentialStore[] = ['file', 'os', 'unknown']

/** Coerces one persisted account onto the current shape, dropping anything odd. */
function normalizeAccount(input: unknown): AccountProfile | null {
  if (!input || typeof input !== 'object') return null
  const raw = input as Record<string, unknown>
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  // The id becomes a directory name, so a persisted value that is not one of
  // ours must not be trusted.
  if (!/^a[0-9a-z]{6,40}$/.test(id)) return null

  const str = (key: string): string => (typeof raw[key] === 'string' ? (raw[key] as string).slice(0, 512) : '')
  const store = raw.credentialStore as CredentialStore

  return {
    id,
    name: str('name'),
    remark: str('remark').slice(0, 200),
    email: str('email'),
    dsid: str('dsid'),
    credentialStore: CREDENTIAL_STORES.includes(store) ? store : 'unknown',
    // The per-account keychain passphrase, already encrypted with safeStorage.
    passphrase: str('passphrase').slice(0, 4096),
    createdAt: Number.isFinite(raw.createdAt) ? Number(raw.createdAt) : Date.now(),
    lastUsedAt: Number.isFinite(raw.lastUsedAt) ? Number(raw.lastUsedAt) : Date.now()
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

  // Accounts: de-duplicate by id and keep the recorded ids intact, otherwise a
  // hand-edited settings.json could point two entries at one session directory.
  const seen = new Set<string>()
  const accounts: AccountProfile[] = []
  for (const entry of Array.isArray(raw.accounts) ? raw.accounts : []) {
    const account = normalizeAccount(entry)
    if (!account || seen.has(account.id)) continue
    seen.add(account.id)
    accounts.push(account)
  }
  out.accounts = accounts
  out.accountCounter = Math.min(100_000, Math.max(1, Math.round(out.accountCounter)))
  if (!accounts.some((account) => account.id === out.activeAccountId)) {
    out.activeAccountId = accounts[0]?.id ?? ''
  }

  return out
}

/**
 * Encrypts a secret for disk. Throws when encryption is unavailable: silently
 * falling back to a `plain:` value would write the keychain passphrase - the key
 * to ipatool's keyring, which holds the Apple session - into settings.json in
 * cleartext, defeating the module's core promise.
 *
 * `plain:` values are still *read* (decryptSecret) so an existing install is not
 * locked out, but they are never written again.
 */
export function encryptSecret(value: string): string {
  if (!value) return ''
  if (!encryptionAvailable()) {
    throw new Error(
      'Refusing to persist the keychain passphrase: safeStorage encryption is unavailable ' +
        '(on Linux install libsecret / gnome-keyring, or set passphraseMode to "none")'
    )
  }
  return ENCRYPTED_PREFIX + safeStorage.encryptString(value).toString('base64')
}

export function decryptSecret(value: string): string {
  if (!value) return ''
  if (value.startsWith('plain:')) return value.slice('plain:'.length)
  if (!value.startsWith(ENCRYPTED_PREFIX)) return ''
  if (!encryptionAvailable()) return ''
  try {
    return safeStorage.decryptString(Buffer.from(value.slice(ENCRYPTED_PREFIX.length), 'base64'))
  } catch {
    return ''
  }
}

export function encryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
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
    this.settings.keychainPassphrase = decryptSecret(this.settings.keychainPassphrase)
    this.settings.accounts = this.settings.accounts.map((account) => ({
      ...account,
      passphrase: decryptSecret(account.passphrase)
    }))
    return this.settings
  }

  /**
   * Settings snapshot for the renderer.
   *
   * Every secret is replaced, not merely trimmed: `keychainPassphrase` keeps the
   * masked placeholder (the UI round-trips it), while account passphrases are
   * blanked outright - the renderer has no legitimate use for them, and
   * `AccountView` never carries one either.
   */
  get(): Settings {
    return {
      ...this.settings,
      keychainPassphrase: this.settings.keychainPassphrase ? '********' : '',
      accounts: this.settings.accounts.map((account) => ({ ...account, passphrase: '' }))
    }
  }

  /** Full settings including plaintext secrets - main process only. */
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
    // Accounts are owned by the account registry, which writes them through
    // replaceAccounts(). A patch that carries them (or an entry missing its
    // secret because it came back from the renderer) must not be allowed to
    // wipe a passphrase - that would lock the account out of its own keyring.
    if (patch.accounts !== undefined) {
      next.accounts = this.settings.accounts
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

  /**
   * Replaces the account list and the active pointer in one write.
   *
   * Kept separate from `update()` because the registry mutates accounts far more
   * often than anything else, and every such change has to be atomic: two
   * half-applied lists would point the next ipatool run at the wrong session
   * directory.
   */
  replaceAccounts(accounts: AccountProfile[], activeAccountId: string, counter?: number): Settings {
    if (!this.loaded) this.init()
    this.settings = {
      ...this.settings,
      accounts,
      activeAccountId,
      ...(counter === undefined ? {} : { accountCounter: Math.max(1, Math.round(counter)) })
    }
    this.persist().catch((error: unknown) => {
      console.warn('[settings] save failed:', error instanceof Error ? error.message : String(error))
    })
    this.emit('change', this.get())
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
   * The global `--keychain-passphrase`, used only by the `manual` and `none`
   * policies. Under the default `auto` policy the accounts registry hands every
   * account its own generated passphrase instead, so that one leaked value
   * cannot unlock every session on the machine.
   */
  async effectivePassphrase(): Promise<string> {
    const mode = this.settings.passphraseMode
    if (mode === 'none') return ''
    if (mode === 'manual') return this.settings.keychainPassphrase
    return ''
  }

  /**
   * Generates an account-scoped passphrase for `auto` mode.
   *
   * The value is round-tripped through the encryptor *before* it is handed out,
   * so a platform without a usable secret store fails here rather than after the
   * account has been created against an unprotected keyring. When encryption is
   * unavailable the policy degrades to `none` - which is not a downgrade in
   * security, it means ipatool uses the OS keyring directly instead of a
   * passphrase-protected file - and the change is logged, never silent.
   */
  async generateAccountPassphrase(): Promise<string> {
    if (this.settings.passphraseMode === 'none') return ''
    const generated = randomBytes(24).toString('base64url')
    try {
      encryptSecret(generated)
      return generated
    } catch (error) {
      console.warn(
        '[settings] cannot protect a per-account keychain passphrase; switching to passphraseMode=none:',
        error instanceof Error ? error.message : String(error)
      )
      this.settings.passphraseMode = 'none'
      this.settings.keychainPassphrase = ''
      await this.persist().catch(() => {})
      this.emit('change', this.get())
      return ''
    }
  }

  /** Public flush used by the profile store after bypassing update(). */
  persistNow(): Promise<void> {
    return this.persist()
  }

  /** Notifies listeners without touching values (used by the accounts store). */
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
      // Seal every secret on its way out: the global passphrase and each
      // account's own. In memory both are plaintext (`load()` decrypts), so the
      // payload - not the settings object - is what has to be checked.
      const payload: Settings = {
        ...this.settings,
        keychainPassphrase: encryptSecret(this.settings.keychainPassphrase),
        accounts: this.settings.accounts.map((account) => ({
          ...account,
          passphrase: encryptSecret(account.passphrase)
        }))
      }

      // Unreachable while `encryptSecret` throws on an unavailable secret store,
      // but asserted anyway: writing the key to ipatool's keyring - which holds
      // the Apple session - in cleartext would silently void the whole model.
      const secrets: string[] = [payload.keychainPassphrase, ...payload.accounts.map((a) => a.passphrase)]
      if (secrets.some((value) => value !== '' && !value.startsWith(ENCRYPTED_PREFIX))) {
        throw new Error('Refusing to persist a cleartext credential')
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

  /** Mirrors the module-level helper; kept for callers holding a store instance. */
  encryptionAvailable(): boolean {
    return encryptionAvailable()
  }

  override(settings: Settings): void {
    this.settings = settings
  }

  get filePath(): string {
    return this.file
  }
}

export const settingsStore = new SettingsStore()
