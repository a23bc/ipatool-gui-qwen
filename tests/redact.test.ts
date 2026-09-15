import { describe, expect, it } from 'vitest'
import { REDACTION, hasSecretFlag, redactArgs, redactText, secretValuesFromArgs } from '@shared/redact'

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

  it('masks a flag-looking token after a secret flag (pflag consumes it as the value)', () => {
    // ipatool's parser treats the token after `-p` as the password even when
    // it starts with a dash, so redaction must swallow it too - over-masking
    // here exactly mirrors what the child process receives.
    expect(redactArgs(['auth', 'login', '-p', '--verbose'])).toEqual([
      'auth',
      'login',
      '-p',
      REDACTION
    ])
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

  it('ignores empty or very short secrets to avoid nuking the line', () => {
    expect(redactText('abc', ['', null, undefined])).toBe('abc')
    expect(redactText('abc', ['a'])).toBe('abc')
    // The floor is 4 characters: real passwords / 2FA codes / passphrases are
    // always longer, while 2-3 letter "secrets" shred legitimate text.
    expect(redactText('abc', ['abc'])).toBe('abc')
    expect(redactText('abcd', ['abcd'])).toBe(REDACTION)
  })

  it('masks case-folded echoes of ASCII secrets (M8)', () => {
    expect(redactText('Invalid password: HUNTER2', ['hunter2'])).toBe(`Invalid password: ${REDACTION}`)
    expect(redactText('pw=HuNtEr2!', ['hunter2'])).toBe(`pw=${REDACTION}!`)
  })

  it('applies the longest secret first so nested secrets cannot shred it (M8)', () => {
    // 'abcd' is a prefix of 'abcdefgh': replacing the short one first would
    // leave the tail of the long one visible and break its match apart.
    expect(redactText('value=abcdefgh', ['abcd', 'abcdefgh'])).toBe(`value=${REDACTION}`)
    expect(redactText('value=abcdefgh', ['abcd', 'abcdefgh'])).not.toContain('efgh')
  })

  it('does not case-fold non-ASCII secrets', () => {
    // Only pure-ASCII secrets get the case-insensitive pass; anything with
    // non-ASCII characters stays exact-match (locale folding is a minefield).
    expect(redactText('pässwort', ['Pässwort'])).toBe('pässwort')
    expect(redactText('pässwort', ['pässwort'])).toBe(REDACTION)
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

describe('secretValuesFromArgs', () => {
  it('harvests the values a raw-console user typed after secret flags', () => {
    expect(secretValuesFromArgs(['auth', 'login', '-p', 'hunter2', '--auth-code', '123456'])).toEqual([
      'hunter2',
      '123456'
    ])
  })

  it('harvests the inline --flag=value form', () => {
    expect(secretValuesFromArgs(['--password=hunter2'])).toEqual(['hunter2'])
    expect(secretValuesFromArgs(['--password='])).toEqual([])
  })

  it('returns nothing for flag-less argv', () => {
    expect(secretValuesFromArgs(['search', 'telegram'])).toEqual([])
  })
})
