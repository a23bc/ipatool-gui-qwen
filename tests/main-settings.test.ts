/**
 * Unit tests for the main-process settings layer.
 *
 * `normalizeSettings` / `coerceProfile` are the defensive core of the whole
 * settings pipeline: every persisted value (possibly hand-edited, corrupted or
 * written by an older build) passes through them before reaching runtime. They
 * are pure functions - the only Electron dependency is `app.getPath` for the
 * default download dir and `safeStorage` for the passphrase, both mocked here.
 */
import { readFile } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  root: '',
  encryptionAvailable: true
}))

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => path.join(mocks.root, name),
    isReady: () => false
  },
  safeStorage: {
    isEncryptionAvailable: () => mocks.encryptionAvailable,
    encryptString: (value: string) => Buffer.from(`mock-enc<${value}>`, 'utf8'),
    decryptString: (buffer: Buffer) => {
      const text = buffer.toString('utf8')
      const match = text.match(/^mock-enc<([\s\S]*)>$/)
      if (!match) throw new Error('bad ciphertext')
      return match[1] ?? ''
    }
  }
}))

import { SettingsStore, defaultSettings, normalizeSettings } from '@main/settings'

beforeEach(() => {
  mocks.root = mkdtempSync(path.join(os.tmpdir(), 'ipatool-settings-'))
  mocks.encryptionAvailable = true
})

describe('defaultSettings', () => {
  it('has sane ranges and starts with no accounts', () => {
    const settings = normalizeSettings(null)
    expect(settings.concurrency).toBe(2)
    expect(settings.searchLimit).toBe(25)
    expect(settings.passphraseMode).toBe('auto')
    // The registry (main/accounts.ts) materialises the first account on init, so
    // normalization itself never invents one.
    expect(settings.accounts).toEqual([])
    expect(settings.activeAccountId).toBe('')
    // The home sandbox is what makes the per-account state directory
    // authoritative, so it has to be on unless the user turns it off.
    expect(settings.isolateSessionHome).toBe(true)
    expect(defaultSettings().downloadDir).toContain('ipatool')
  })
})

describe('normalizeSettings', () => {
  it('falls back to defaults for non-object input', () => {
    for (const bad of [null, undefined, 42, 'settings']) {
      const out = normalizeSettings(bad)
      expect(out.concurrency).toBe(2)
      expect(out.accounts).toEqual([])
    }
    // An array is an object but carries no settings fields; same outcome.
    expect(normalizeSettings([]).concurrency).toBe(2)
  })

  it('ignores unknown fields', () => {
    const out = normalizeSettings({ totallyUnknownKey: 'x', theme: 'dark' })
    expect(out).not.toHaveProperty('totallyUnknownKey')
    expect(out.theme).toBe('dark')
  })

  it('rejects values whose type does not match the default', () => {
    const out = normalizeSettings({
      concurrency: '4', // string where a number is expected
      verbose: 'yes', // string where a boolean is expected
      downloadDir: 42, // number where a string is expected
      searchLimit: Number.NaN
    })
    expect(out.concurrency).toBe(2)
    expect(out.verbose).toBe(false)
    expect(typeof out.downloadDir).toBe('string')
    expect(out.searchLimit).toBe(25)
  })

  it('applies range guards', () => {
    const out = normalizeSettings({
      concurrency: 99,
      searchLimit: 0,
      purchasesPageSize: 100_000,
      maxLogLines: 3
    })
    expect(out.concurrency).toBe(8)
    expect(out.searchLimit).toBe(1)
    expect(out.purchasesPageSize).toBe(1000)
    expect(out.maxLogLines).toBe(100)
  })

  it('rounds fractional numbers', () => {
    const out = normalizeSettings({ concurrency: 2.7 })
    expect(out.concurrency).toBe(3)
  })

  it('validates enum-like fields', () => {
    const out = normalizeSettings({
      defaultPlatform: 'android',
      theme: 'solarized',
      locale: 'fr-FR',
      passphraseMode: 'yolo'
    })
    expect(out.defaultPlatform).toBe('')
    expect(out.theme).toBe('system')
    expect(out.locale).toBe('system')
    expect(out.passphraseMode).toBe('auto')

    const ok = normalizeSettings({
      defaultPlatform: 'visionos',
      theme: 'dark',
      locale: 'zh-CN',
      passphraseMode: 'none'
    })
    expect(ok.defaultPlatform).toBe('visionos')
    expect(ok.theme).toBe('dark')
    expect(ok.locale).toBe('zh-CN')
    expect(ok.passphraseMode).toBe('none')
  })






  it('defaults an empty artworkCountry to "us"', () => {
    expect(normalizeSettings({ artworkCountry: '   ' }).artworkCountry).toBe('us')
  })
})

/** Builds a well-formed persisted account entry. */
function persistedAccount(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'a1bcdefg',
    name: 'Account 1',
    remark: '',
    email: 'a@example.com',
    dsid: '12345',
    credentialStore: 'file',
    passphrase: 'enc:v1:xyz',
    createdAt: 1,
    lastUsedAt: 2,
    ...over
  }
}

/** A single account in the shape the registry stores internally. */
function liveAccount(passphrase: string): Parameters<SettingsStore['replaceAccounts']>[0] {
  return [
    {
      id: 'a1bcdefg',
      name: 'Account 1',
      remark: '',
      email: '',
      dsid: '',
      credentialStore: 'file',
      passphrase,
      createdAt: 1,
      lastUsedAt: 1
    }
  ]
}

describe('normalizeSettings: accounts', () => {
  it('keeps well-formed accounts and drops entries whose id is not ours', () => {
    const out = normalizeSettings({
      accounts: [
        persistedAccount(),
        // Ids become directory names, so a persisted path traversal must not
        // survive the round trip.
        persistedAccount({ id: '../../etc/passwd' }),
        persistedAccount({ id: 'a2hijklm' }),
        persistedAccount({ id: 'a2hijklm' }) // duplicate
      ]
    })
    expect(out.accounts.map((entry) => entry.id)).toEqual(['a1bcdefg', 'a2hijklm'])
  })

  it('coerces an unknown credential store back to "unknown"', () => {
    const out = normalizeSettings({ accounts: [persistedAccount({ credentialStore: 'hacked' })] })
    expect(out.accounts[0]?.credentialStore).toBe('unknown')
  })

  it('re-points the active id when it does not name a real account', () => {
    const out = normalizeSettings({ accounts: [persistedAccount()], activeAccountId: 'agonegone' })
    expect(out.activeAccountId).toBe('a1bcdefg')

    const none = normalizeSettings({ accounts: [], activeAccountId: 'a1bcdefg' })
    expect(none.activeAccountId).toBe('')
  })

  it('never lets an update() patch wipe an account passphrase', () => {
    const store = new SettingsStore()
    store.init()
    store.replaceAccounts(liveAccount('secret-value'), 'a1bcdefg')
    expect(store.getInternal().accounts[0]?.passphrase).toBe('secret-value')

    // The renderer only ever sees a blanked copy, so echoing the snapshot back
    // through update() must not be read as "the user cleared the secret".
    store.update({ accounts: store.get().accounts, theme: 'dark' })
    expect(store.getInternal().accounts[0]?.passphrase).toBe('secret-value')
    expect(store.getInternal().theme).toBe('dark')
  })

  it('get() strips the per-account passphrase from the renderer snapshot', () => {
    const store = new SettingsStore()
    store.init()
    store.replaceAccounts(liveAccount('secret-value'), 'a1bcdefg')
    expect(store.get().accounts[0]?.passphrase).toBe('')
    expect(store.getInternal().accounts[0]?.passphrase).toBe('secret-value')
  })

  it('encrypts every account passphrase on disk', async () => {
    const store = new SettingsStore()
    store.init()
    store.replaceAccounts(liveAccount('super-secret'), 'a1bcdefg')
    await store.persistNow()

    const raw = await readFile(store.filePath, 'utf8')
    expect(raw).not.toContain('super-secret')
    expect(raw).toContain('enc:v1:')

    const reloaded = new SettingsStore()
    reloaded.init()
    await reloaded.load()
    expect(reloaded.getInternal().accounts[0]?.passphrase).toBe('super-secret')
  })
})


describe('SettingsStore passphrase handling', () => {
  it('only hands out the global passphrase under the manual policy', async () => {
    const store = new SettingsStore()
    store.init()

    // 'auto' generates per account, so the global value stays empty - one leaked
    // passphrase must not unlock every session on the machine.
    expect(await store.effectivePassphrase()).toBe('')

    store.update({ passphraseMode: 'manual', keychainPassphrase: 'sekrit-value' })
    expect(await store.effectivePassphrase()).toBe('sekrit-value')

    store.update({ passphraseMode: 'none' })
    expect(await store.effectivePassphrase()).toBe('')
  })

  it('generates a distinct, encryptable passphrase per call', async () => {
    const store = new SettingsStore()
    store.init()
    const first = await store.generateAccountPassphrase()
    const second = await store.generateAccountPassphrase()
    expect(first.length).toBeGreaterThan(20)
    expect(second).not.toBe(first)
  })

  it('degrades to passphraseMode=none when safeStorage is unavailable', async () => {
    mocks.encryptionAvailable = false
    const store = new SettingsStore()
    store.init()

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const passphrase = await store.generateAccountPassphrase()
    warn.mockRestore()

    // Not a silent downgrade: 'none' means ipatool uses the OS keyring directly.
    expect(passphrase).toBe('')
    expect(store.getInternal().passphraseMode).toBe('none')
    expect(store.getInternal().keychainPassphrase).toBe('')
  })

  it('update() preserves the secret when the UI echoes back the mask', async () => {
    const store = new SettingsStore()
    store.init()
    store.update({ passphraseMode: 'manual', keychainPassphrase: 'sekrit-value' })
    store.update({ keychainPassphrase: '********', theme: 'dark' })
    expect(store.getInternal().keychainPassphrase).toBe('sekrit-value')
    expect(store.getInternal().theme).toBe('dark')
  })

  it('get() masks a set passphrase and reports "" when none exists', () => {
    const store = new SettingsStore()
    store.init()
    expect(store.get().keychainPassphrase).toBe('')
    store.update({ passphraseMode: 'manual', keychainPassphrase: 'sekrit-value' })
    expect(store.get().keychainPassphrase).toBe('********')
    expect(store.getInternal().keychainPassphrase).toBe('sekrit-value')
  })

  it('load() falls back to defaults on a corrupt file', async () => {
    const store = new SettingsStore()
    store.init()
    const { writeFile, mkdir } = await import('node:fs/promises')
    await mkdir(path.dirname(store.filePath), { recursive: true })
    await writeFile(store.filePath, '{ not json !!!', 'utf8')
    const settings = await store.load()
    expect(settings.concurrency).toBe(2)
  })
})
