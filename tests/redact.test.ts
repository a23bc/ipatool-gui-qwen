import { describe, expect, it } from 'vitest'
import { REDACTION, hasSecretFlag, redactArgs, redactText } from '@shared/redact'

describe('redactArgs', () => {
  it('masks the Apple ID password', () => {
    expect(redactArgs(['auth', 'login', '-e', 'me@example.com', '-p', 'hunter2'])).toEqual([
      'auth',
      'login',
      '-e',
      'me@example.com',
      '-p',
      REDACTION
    ])
  })

  it('masks the long form and the 2FA code', () => {
    const redacted = redactArgs(['auth', 'login', '--password', 'pw', '--auth-code', '123456'])
    expect(redacted).toEqual(['auth', 'login', '--password', REDACTION, '--auth-code', REDACTION])
  })

  it('masks the inline --flag=value form', () => {
    expect(redactArgs(['--password=hunter2'])).toEqual([`--password=${REDACTION}`])
  })

  it('masks the keychain passphrase', () => {
    const redacted = redactArgs(['search', 'x', '--keychain-passphrase', 'sekrit'])
    expect(redacted).toContain(REDACTION)
    expect(redacted.join(' ')).not.toContain('sekrit')
  })

  it('leaves ordinary arguments untouched', () => {
    const args = ['download', '-i', '686449807', '-o', '/tmp/ipas', '--purchase']
    expect(redactArgs(args)).toEqual(args)
  })

  it('never throws when a secret flag is the last argument', () => {
    expect(redactArgs(['auth', 'login', '-p'])).toEqual(['auth', 'login', '-p'])
  })

  it('produces a string that contains no secret material', () => {
    const args = ['auth', 'login', '-e', 'me@example.com', '-p', 'Sup3rS3cret!', '--auth-code', '998877']
    const line = redactArgs(args).join(' ')
    expect(line).not.toContain('Sup3rS3cret!')
    expect(line).not.toContain('998877')
    // The e-mail is not a secret in this context and stays readable.
    expect(line).toContain('me@example.com')
  })
})

describe('redactText', () => {
  it('masks literal secrets inside log output', () => {
    const line = 'logging in with password hunter2 for me@example.com'
    expect(redactText(line, ['hunter2'])).toBe(`logging in with password ${REDACTION} for me@example.com`)
  })

  it('masks several secrets in one pass', () => {
    expect(redactText('a=sekrit b=sekrit2', ['sekrit', 'sekrit2'])).not.toContain('sekrit')
  })

  it('ignores empty or single-character secrets to avoid nuking the line', () => {
    expect(redactText('abc', ['', null, undefined])).toBe('abc')
    expect(redactText('abc', ['a'])).toBe('abc')
  })

  it('is safe with regex metacharacters in the secret', () => {
    const secret = 'p@ss.w*rd+(x)?[y]'
    expect(redactText(`value=${secret}`, [secret])).toBe(`value=${REDACTION}`)
  })
})

describe('hasSecretFlag', () => {
  it('detects secret-bearing flags', () => {
    expect(hasSecretFlag(['auth', 'login', '-p', 'x'])).toBe(true)
    expect(hasSecretFlag(['--keychain-passphrase=y'])).toBe(true)
  })

  it('returns false for benign commands', () => {
    expect(hasSecretFlag(['search', 'telegram', '-l', '10'])).toBe(false)
  })
})
