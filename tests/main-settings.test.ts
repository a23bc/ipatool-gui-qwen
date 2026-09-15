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
  it('has sane ranges; the default profile is created by the profiles layer', () => {
    const settings = normalizeSettings(null)
    expect(settings.concurrency).toBe(2)
    expect(settings.searchLimit).toBe(25)
    expect(settings.passphraseMode).toBe('auto')
    // normalizeSettings() only synthesises a p-default profile when migrating
    // a persisted object; a fresh default starts empty and profiles.ensureDefault()
    // materialises the default account on first use.
    expect(settings.profiles).toEqual([])
    expect(settings.activeProfileId).toBe('')
    expect(defaultSettings().downloadDir).toContain('ipatool')
  })
})

describe('normalizeSettings', () => {
  it('falls back to defaults for non-object input', () => {
    for (const bad of [null, undefined, 42, 'settings']) {
      const out = normalizeSettings(bad)
      expect(out.concurrency).toBe(2)
      expect(out.profiles).toEqual([])
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

  it('coerces profiles field-by-field and drops unusable entries', () => {
    const out = normalizeSettings({
      profiles: [
        null,
        42,
        'nope',
        { name: 'missing id' },
        { id: '' },
        {
          id: 'p1',
          name: 99, // wrong type -> placeholder
          remark: null, // wrong type -> ''
          email: 'me@example.com',
          stateDir: '~/state',
          createdAt: 'yesterday', // wrong type -> Date.now()
          lastUsedAt: 5
        }
      ]
    })
    expect(out.profiles).toHaveLength(1)
    const p = out.profiles[0]
    expect(p?.id).toBe('p1')
    expect(p?.name).toBe('Account')
    expect(p?.remark).toBe('')
    expect(p?.email).toBe('me@example.com')
    expect(p?.stateDir).toBe('~/state')
    expect(typeof p?.createdAt).toBe('number')
    expect(p?.lastUsedAt).toBe(5)
  })

  it('migrates a legacy global stateDir into the default profile', () => {
    const out = normalizeSettings({
      stateDir: '/home/user/.ipatool-legacy',
      lastEmail: 'old@example.com'
    })
    expect(out.profiles).toHaveLength(1)
    expect(out.profiles[0]?.id).toBe('p-default')
    expect(out.profiles[0]?.stateDir).toBe('/home/user/.ipatool-legacy')
    expect(out.profiles[0]?.name).toBe('old@example.com')
  })

  it('keeps the profile counter ahead of the profile count', () => {
    const out = normalizeSettings({
      profileCounter: 1,
      profiles: [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    })
    expect(out.profileCounter).toBe(4)
  })

  it('re-points a dangling activeProfileId at the first profile', () => {
    const out = normalizeSettings({
      activeProfileId: 'deleted-profile',
      profiles: [{ id: 'a' }, { id: 'b' }]
    })
    expect(out.activeProfileId).toBe('a')
  })

  it('keeps a valid activeProfileId', () => {
    const out = normalizeSettings({
      activeProfileId: 'b',
      profiles: [{ id: 'a' }, { id: 'b' }]
    })
    expect(out.activeProfileId).toBe('b')
  })

  it('defaults an empty artworkCountry to "us"', () => {
    expect(normalizeSettings({ artworkCountry: '   ' }).artworkCountry).toBe('us')
  })
})

describe('SettingsStore passphrase handling (M1)', () => {
  it('encrypts the generated passphrase at rest and never writes plaintext', async () => {
    const store = new SettingsStore()
    store.init()
    const passphrase = await store.effectivePassphrase()
    expect(passphrase.length).toBeGreaterThan(20)

    const raw = await readFile(store.filePath, 'utf8')
    expect(raw).not.toContain(passphrase)
    expect(raw).not.toContain('plain:')
    expect(raw).toContain('enc:v1:')

    // A fresh store reads the encrypted value back.
    const reloaded = new SettingsStore()
    reloaded.init()
    await reloaded.load()
    expect(reloaded.getInternal().keychainPassphrase).toBe(passphrase)
    // ...while the renderer-facing snapshot stays masked.
    expect(reloaded.get().keychainPassphrase).toBe('********')
  })

  it('returns the same passphrase on subsequent calls', async () => {
    const store = new SettingsStore()
    store.init()
    const first = await store.effectivePassphrase()
    const second = await store.effectivePassphrase()
    expect(second).toBe(first)
  })

  it('refuses to persist in plaintext when safeStorage is unavailable and degrades to mode=none', async () => {
    mocks.encryptionAvailable = false
    const store = new SettingsStore()
    store.init()

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const passphrase = await store.effectivePassphrase()
    warn.mockRestore()

    expect(passphrase).toBe('')
    expect(store.getInternal().passphraseMode).toBe('none')
    expect(store.getInternal().keychainPassphrase).toBe('')

    const raw = await readFile(store.filePath, 'utf8')
    expect(raw).not.toContain('plain:')
  })

  it('passphraseMode=none never generates or stores anything', async () => {
    const store = new SettingsStore()
    store.init()
    store.update({ passphraseMode: 'none' })
    expect(await store.effectivePassphrase()).toBe('')
    expect(store.getInternal().keychainPassphrase).toBe('')
  })

  it('update() preserves the secret when the UI echoes back the mask', async () => {
    const store = new SettingsStore()
    store.init()
    const passphrase = await store.effectivePassphrase()
    store.update({ keychainPassphrase: '********', theme: 'dark' })
    expect(store.getInternal().keychainPassphrase).toBe(passphrase)
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
