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
