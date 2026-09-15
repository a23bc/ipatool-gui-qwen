/**
 * Pure-function tests for main/api.ts: normalizeApp (zerolog payload -> our
 * StoreApp shape) and loginStatusFromCode (error code -> dialog next step).
 *
 * `electron` is mocked because api.ts transitively loads settings/engine at
 * import time; the functions under test are pure.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => `/tmp/ipatool-api-test/${name}`,
    isReady: () => false
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.from(''),
    decryptString: () => ''
  }
}))

import { loginStatusFromCode, normalizeApp } from '@main/api'

describe('normalizeApp', () => {
  it('maps a full ipatool app object', () => {
    expect(
      normalizeApp({
        id: 686449807,
        bundleID: 'org.telegram.Telegram',
        name: 'Telegram',
        version: '10.5.1',
        price: 0,
        platforms: ['iphone', 'ipad'],
        purchaseDate: '2024-01-02T03:04:05Z'
      })
    ).toEqual({
      id: 686449807,
      bundleID: 'org.telegram.Telegram',
      name: 'Telegram',
      version: '10.5.1',
      price: 0,
      platforms: ['iphone', 'ipad'],
      purchaseDate: '2024-01-02T03:04:05Z'
    })
  })

  it('accepts the alternate key spellings ipatool has used', () => {
    const app = normalizeApp({ trackId: 42, bundleId: 'com.example.x', trackName: 'Example' })
    expect(app).toMatchObject({ id: 42, bundleID: 'com.example.x', name: 'Example' })
  })

  it('keeps an app with no id when a name or bundle id identifies it', () => {
    expect(normalizeApp({ bundleID: 'com.example.only' })?.id).toBe(0)
    expect(normalizeApp({ name: 'Nameless' })?.name).toBe('Nameless')
  })

  it('rejects values that cannot describe an app', () => {
    expect(normalizeApp(null)).toBeNull()
    expect(normalizeApp(undefined)).toBeNull()
    expect(normalizeApp('app')).toBeNull()
    expect(normalizeApp({})).toBeNull()
    expect(normalizeApp({ id: 0 })).toBeNull()
  })

  it('coerces bad numeric fields instead of propagating NaN', () => {
    const app = normalizeApp({ id: 7, bundleID: 'com.example.n', name: 'N', price: 'free' })
    expect(app?.price).toBe(0)
  })

  it('omits optional fields that are absent or empty', () => {
    const app = normalizeApp({ id: 7, bundleID: 'com.example.n', name: 'N', purchaseDate: '' })
    expect(app && 'purchaseDate' in app).toBe(false)
    expect(app && 'platforms' in app).toBe(false)
  })

  it('stringifies a non-array platforms value safely', () => {
    const app = normalizeApp({ id: 7, name: 'N', platforms: 'iphone' })
    expect(app && 'platforms' in app).toBe(false)
  })
})

describe('loginStatusFromCode', () => {
  it('routes 2FA to the code step', () => {
    expect(loginStatusFromCode('two-factor-required')).toBe('needs-2fa')
  })

  it('routes a missing OR wrong passphrase back to the passphrase prompt (m-M11)', () => {
    expect(loginStatusFromCode('passphrase-required')).toBe('passphrase-required')
    expect(loginStatusFromCode('passphrase-invalid')).toBe('passphrase-required')
  })

  it('groups credential failures', () => {
    expect(loginStatusFromCode('bad-credentials')).toBe('bad-credentials')
    expect(loginStatusFromCode('account-locked')).toBe('bad-credentials')
  })

  it('surfaces rate limiting distinctly', () => {
    expect(loginStatusFromCode('rate-limited')).toBe('rate-limited')
  })

  it('degrades everything else to a generic error', () => {
    expect(loginStatusFromCode('network')).toBe('error')
    expect(loginStatusFromCode('unknown')).toBe('error')
    expect(loginStatusFromCode('app-not-found')).toBe('error')
  })
})
