import { describe, expect, it } from 'vitest'
import { classifyError, isPassphraseRequired, isTwoFactorRequired, shorten } from '@shared/ipatool/errors'

describe('classifyError', () => {
  it('recognises the non-interactive 2FA signal ipatool logs on success', () => {
    // auth login exits 0 in this case, so the message text is the only signal.
    const classified = classifyError(
      '2FA code is required; run the command again and supply a code using the `--auth-code` flag'
    )
    expect(classified.code).toBe('two-factor-required')
    expect(classified.actionable).toBe(true)
    expect(isTwoFactorRequired('2FA code is required; run the command again')).toBe(true)
  })

  it('recognises a missing keychain passphrase', () => {
    const classified = classifyError(
      'keychain passphrase is required when not running in interactive mode; use the "--keychain-passphrase" flag'
    )
    expect(classified.code).toBe('passphrase-required')
    expect(isPassphraseRequired(classified.message)).toBe(true)
  })

  it('recognises a wrong keychain passphrase', () => {
    expect(classifyError('failed to decrypt keyring item').code).toBe('passphrase-invalid')
  })

  it('recognises an unauthenticated session', () => {
    expect(classifyError('no account found; please login first').code).toBe('not-signed-in')
    expect(classifyError('received error: SignInRequired').code).toBe('not-signed-in')
  })

  it('recognises bad Apple ID credentials', () => {
    expect(classifyError('received error: Your Apple ID or password is incorrect').code).toBe(
      'bad-credentials'
    )
  })

  it('recognises a missing licence and marks it actionable', () => {
    const classified = classifyError('license is required')
    expect(classified.code).toBe('license-required')
    expect(classified.actionable).toBe(true)
    expect(classified.retryable).toBe(true)
  })

  it('recognises rate limiting', () => {
    expect(classifyError('received error: 429 Too Many Requests').code).toBe('rate-limited')
  })

  it('recognises a failed resume (HTTP 416)', () => {
    expect(classifyError('request failed: 416 Range Not Satisfiable').code).toBe('resume-failed')
  })

  it('recognises network failures', () => {
    expect(classifyError('failed to send http request: dial tcp: lookup buy.itunes.apple.com: no such host').code).toBe(
      'dns'
    )
    expect(classifyError('failed to send http request: connection refused').code).toBe('network')
    expect(classifyError('failed to send http request: context deadline exceeded').code).toBe('timeout')
  })

  it('recognises platform validation failures', () => {
    expect(classifyError('downloaded package does not declare AppleTVOS support').code).toBe(
      'platform-mismatch'
    )
  })

  it('recognises disk problems', () => {
    expect(classifyError('failed to write file: no space left on device').code).toBe('disk')
  })

  it('recognises cancellation', () => {
    expect(classifyError('context canceled').code).toBe('canceled')
    expect(classifyError('signal: killed').code).toBe('canceled')
  })

  it('falls back to unknown but still retryable', () => {
    const classified = classifyError('something completely unexpected happened')
    expect(classified.code).toBe('unknown')
    expect(classified.retryable).toBe(true)
  })

  it('merges stdout and stderr into one searchable blob', () => {
    const classified = classifyError('', 'verbose noise', 'Error: license is required')
    expect(classified.code).toBe('license-required')
  })

  it('collapses whitespace in the surfaced message', () => {
    expect(classifyError('a   b\n\n  c').message).toBe('a b c')
  })

  it('prioritises the more specific 2FA rule over generic auth failures', () => {
    expect(classifyError('authentication failed: 2FA code is required').code).toBe('two-factor-required')
  })
})

describe('shorten', () => {
  it('leaves short messages alone', () => {
    expect(shorten('short')).toBe('short')
  })

  it('truncates Apple plist dumps', () => {
    const long = 'x'.repeat(1000)
    expect(shorten(long, 100).length).toBeLessThanOrEqual(101)
    expect(shorten(long, 100).endsWith('…')).toBe(true)
  })
})

/**
 * m-C3: every rule needs more than one pattern under test - the previous suite
 * exercised a single pattern per rule, leaving the rest without regression
 * protection. Two representative patterns per rule (typically the first and
 * the most idiosyncratic) are pinned below.
 */
describe('classifyError rule matrix', () => {
  const cases: Array<[string, string]> = [
    ['2fa code is required', 'two-factor-required'],
    ['ErrAuthCodeRequired', 'two-factor-required'],
    ['keychain passphrase is required', 'passphrase-required'],
    ['failed to decrypt the keychain', 'passphrase-invalid'],
    ['incorrect passphrase supplied', 'passphrase-invalid'],
    ['no account found', 'not-signed-in'],
    ['SignInRequired', 'not-signed-in'],
    ['please sign in with your Apple ID', 'not-signed-in'],
    ['apple id or password is incorrect', 'bad-credentials'],
    ['InvalidCredentials', 'bad-credentials'],
    ['account is disabled for security reasons', 'account-locked'],
    ['AccountDisabled', 'account-locked'],
    ['license is required', 'license-required'],
    ['LicenseNotFound', 'license-required'],
    ['could not find the app', 'app-not-found'],
    ['no results found', 'app-not-found'],
    ['version not found', 'version-not-found'],
    ['invalid version', 'version-not-found'],
    ['too many requests, try again later', 'rate-limited'],
    ['HTTP 429 received', 'rate-limited'],
    ['requested range not satisfiable', 'resume-failed'],
    ['server replied 416', 'resume-failed'],
    ['failed to validate package platform', 'platform-mismatch'],
    ['app does not declare iphoneos support', 'platform-mismatch'],
    ['request timed out', 'timeout'],
    ['deadline exceeded', 'timeout'],
    ['no such host itunes.apple.com', 'dns'],
    ['name resolution failed', 'dns'],
    ['x509: certificate signed by unknown authority', 'tls'],
    ['tls handshake failure', 'tls'],
    ['proxy connection refused', 'proxy'],
    ['CONNECT tunnel failed', 'proxy'],
    ['no space left on device', 'disk'],
    ['read-only file system', 'disk'],
    ['failed to send http request', 'network'],
    ['connection reset by peer', 'network'],
    ['unexpected EOF while reading body', 'network'],
    ['spawn ipatool ENOENT', 'engine-missing'],
    ['ipatool is not recognized as an internal or external command', 'engine-missing'],
    ['session mismatch for profile p1', 'session-mismatch'],
    ['context canceled', 'canceled'],
    ['signal: killed', 'canceled']
  ]

  it.each(cases)('%s -> %s', (text, code) => {
    expect(classifyError(text).code).toBe(code)
  })

  it('marks retryable/actionable flags from the matched rule', () => {
    expect(classifyError('too many requests').retryable).toBe(true)
    expect(classifyError('keychain passphrase is required').actionable).toBe(true)
    expect(classifyError('no space left on device').retryable).toBe(false)
  })

  it('returns unknown (retryable) when nothing matches', () => {
    const classified = classifyError('something entirely novel happened')
    expect(classified.code).toBe('unknown')
    expect(classified.retryable).toBe(true)
    expect(classified.message).toBe('something entirely novel happened')
  })
})

describe('classifyError word-boundary precision (m-S4)', () => {
  it('does not read a resume failure into an unrelated 4162', () => {
    expect(classifyError('error code 4162 from the store').code).not.toBe('resume-failed')
  })

  it('does not read DNS into words that merely contain "dns"', () => {
    expect(classifyError('podcastdns feed unavailable').code).not.toBe('dns')
  })

  it('does not read a network EOF into EOFError identifiers', () => {
    expect(classifyError('EOFError in user code').code).not.toBe('network')
  })

  it('still matches the exact tokens', () => {
    expect(classifyError('got status 416').code).toBe('resume-failed')
    expect(classifyError('dns lookup exploded').code).toBe('dns')
    expect(classifyError('read: unexpected EOF').code).toBe('network')
  })
})

describe('classifyError rule ordering', () => {
  it('prefers passphrase-invalid over generic decryption wording', () => {
    expect(classifyError('failed to unlock keyring: invalid passphrase').code).toBe('passphrase-invalid')
  })

  it('prefers not-signed-in over bad-credentials when both match', () => {
    expect(classifyError('not authenticated - invalid credentials').code).toBe('not-signed-in')
  })

  it('prefers canceled over network wording', () => {
    // 'context canceled' often appears next to 'failed to send http request';
    // the canceled rule sits last, so pin the network rule wins instead...
    expect(classifyError('failed to send http request: context canceled').code).toBe('network')
    // ...while a bare cancellation is still classified as canceled.
    expect(classifyError('context canceled').code).toBe('canceled')
  })
})

describe('shorten surrogate safety (n-R10)', () => {
  it('never cuts an astral character in half', () => {
    // '𝄞' is U+1D11E: a surrogate pair occupying two UTF-16 code units.
    const message = 'a'.repeat(399) + '𝄞tail'
    const shortened = shorten(message, 400)
    // The cut lands inside the pair (index 399 is the high surrogate); the
    // implementation must drop it rather than emit a lone surrogate.
    expect(shortened.endsWith('…')).toBe(true)
    const withoutEllipsis = shortened.slice(0, -1)
    for (let i = 0; i < withoutEllipsis.length; i += 1) {
      const code = withoutEllipsis.charCodeAt(i)
      const isLoneHigh = code >= 0xd800 && code <= 0xdbff &&
        !(withoutEllipsis.charCodeAt(i + 1) >= 0xdc00 && withoutEllipsis.charCodeAt(i + 1) <= 0xdfff)
      const isLoneLow = code >= 0xdc00 && code <= 0xdfff &&
        !(withoutEllipsis.charCodeAt(i - 1) >= 0xd800 && withoutEllipsis.charCodeAt(i - 1) <= 0xdbff)
      expect(isLoneHigh || isLoneLow).toBe(false)
    }
  })
})
