/**
 * Unit tests for the multi-account primitives.
 *
 * These functions decide whether two sessions are the same Apple account, which
 * profile owns the machine-wide credential slot, and how the OS credential tools
 * are driven. Every one of them is a "wrong answer looks fine at runtime"
 * candidate - a mistaken identity match would act as the wrong Apple ID, and a
 * bad `security` argument would silently write garbage into a Keychain - so they
 * are all covered directly instead of through the Electron layer.
 *
 * The upstream contract they encode (ipatool v2.6):
 *   - `cmd/constants.go` / `cmd/common.go`: service `ipatool-auth.service`, key
 *     `account`, backend order [keychain, secret-service, file];
 *   - `cmd/state_directory.go`: `$XDG_STATE_HOME/ipatool`, else `$HOME/.ipatool`;
 *   - `pkg/appstore/appstore_login.go`: the whole `Account` struct is stored,
 *     password included.
 */

import { describe, expect, it } from 'vitest'
import type { AccountProfile } from '@shared/types'
import {
  IPATOOL_KEYCHAIN_KEY,
  IPATOOL_KEYCHAIN_SERVICE,
  accountDisplayName,
  accountDirName,
  allocateAccountName,
  decodeSecretToolOutput,
  decodeSecurityOutput,
  identityOf,
  isAccountId,
  newAccountId,
  parseAccountRecord,
  probableCredentialSlot,
  profileIdentity,
  resolveActiveId,
  sandboxHomeFor,
  sameIdentity,
  secretToolReadArgs,
  secretToolWriteArgs,
  securityInteractiveCommand,
  securityReadArgs,
  securityWriteCommand,
  slotOwner,
  sortAccounts
} from '@shared/accounts'

function profile(over: Partial<AccountProfile> = {}): AccountProfile {
  return {
    id: 'a1bcdefg',
    name: 'Account 1',
    remark: '',
    email: 'me@example.com',
    dsid: '',
    credentialStore: 'unknown',
    passphrase: '',
    createdAt: 1,
    lastUsedAt: 1,
    ...over
  }
}

const RECORD = JSON.stringify({
  email: 'me@example.com',
  name: 'Me',
  passwordToken: 'tok',
  directoryServicesIdentifier: '12345',
  storeFront: '143441-1,29',
  password: 'hunter2',
  pod: 'p1'
})

describe('parseAccountRecord', () => {
  it('accepts a record that identifies an account', () => {
    const record = parseAccountRecord(RECORD)
    expect(record?.email).toBe('me@example.com')
    expect(record?.directoryServicesIdentifier).toBe('12345')
    // The password is parsed but never surfaced anywhere else in the app.
    expect(record?.password).toBe('hunter2')
  })

  it('rejects anything that is not a JSON object', () => {
    for (const bad of [null, undefined, '', '   ', 'not json', '[]', '"str"', '42', 'null']) {
      expect(parseAccountRecord(bad as string | null)).toBeNull()
    }
  })

  it('rejects JSON that carries no identity at all', () => {
    // The slot is shared with the terminal CLI and with any other tool using the
    // same service name, so "valid JSON" must not be mistaken for "our session".
    expect(parseAccountRecord('{}')).toBeNull()
    expect(parseAccountRecord(JSON.stringify({ pod: 'p1' }))).toBeNull()
  })

  it('accepts a record that only carries a DirectoryServicesID', () => {
    const record = parseAccountRecord(JSON.stringify({ directoryServicesIdentifier: '999' }))
    expect(record?.directoryServicesIdentifier).toBe('999')
    expect(record?.email).toBe('')
  })
})

describe('identity', () => {
  it('prefers the DirectoryServicesID when both sides have one', () => {
    // Apple keys licences on the DSID, and it survives an e-mail change.
    expect(
      sameIdentity({ email: 'old@example.com', dsid: '1' }, { email: 'new@example.com', dsid: '1' })
    ).toBe(true)
    expect(sameIdentity({ email: 'x@example.com', dsid: '1' }, { email: 'x@example.com', dsid: '2' })).toBe(false)
  })

  it('falls back to the e-mail when a DSID is missing on either side', () => {
    expect(sameIdentity({ email: 'A@Example.com', dsid: '' }, { email: 'a@example.com', dsid: '9' })).toBe(true)
    expect(sameIdentity({ email: 'a@example.com', dsid: '' }, { email: 'b@example.com', dsid: '9' })).toBe(false)
  })

  it('never claims a match when both sides are unknown', () => {
    // Otherwise a signed-out profile would look like "the active session".
    expect(sameIdentity({ email: '', dsid: '' }, { email: '', dsid: '' })).toBe(false)
  })

  it('normalises case and whitespace', () => {
    expect(identityOf(parseAccountRecord(JSON.stringify({ email: ' Me@Example.com ' })))).toEqual({
      email: 'me@example.com',
      dsid: ''
    })
  })

  it('does not attribute an unattributable record to anyone', () => {
    expect(slotOwner(null, [profile()])).toBeNull()
    expect(slotOwner(parseAccountRecord('{}'), [profile()])).toBeNull()
  })

  it('finds the profile that owns the slot', () => {
    const accounts = [profile({ id: 'a1bcdefg' }), profile({ id: 'a2hijklm', email: 'other@example.com' })]
    const owner = slotOwner(parseAccountRecord(RECORD), accounts)
    expect(owner?.id).toBe('a1bcdefg')
    expect(slotOwner(parseAccountRecord(RECORD), [profile({ email: 'nobody@example.com' })])).toBeNull()
    expect(profileIdentity(profile())).toEqual({ email: 'me@example.com', dsid: '' })
  })
})

describe('credential store policy', () => {
  it('reports a machine-wide slot only where upstream really uses one', () => {
    // macOS: the Keychain backend is compiled in and first in the allowed list.
    expect(probableCredentialSlot('darwin')).toBe('os')
    // Linux: the Secret Service is second in the list. (The app makes it
    // unreachable so it lands on `file`, which is a separate, deliberate step.)
    expect(probableCredentialSlot('linux')).toBe('os')
    // Windows: only `wincred` and `file` exist, and `wincred` is not allowed.
    expect(probableCredentialSlot('win32')).toBe('file')
  })

  it('sandboxes the variables ipatool actually reads for a home directory', () => {
    // `machine.HomeDirectory()` joins HOMEDRIVE and HOMEPATH on Windows and reads
    // HOME everywhere else - those are the only variables that matter.
    expect(sandboxHomeFor('win32')).toEqual(['HOMEDRIVE', 'HOMEPATH'])
    expect(sandboxHomeFor('darwin')).toEqual(['HOME'])
    expect(sandboxHomeFor('linux')).toEqual(['HOME'])
  })
})

describe('naming', () => {
  it('builds ids that are safe as directory names', () => {
    const id = newAccountId(1_700_000_000_000, 'DEADBEEF')
    expect(id).toMatch(/^a[0-9a-z]+$/)
    expect(accountDirName(id)).toBe(id)
  })

  it('strips anything that could escape the accounts root', () => {
    expect(accountDirName('a1b../../etc')).toBe('a1betc')
    expect(accountDirName('')).toBe('a0000000')
    expect(accountDirName('!!!')).toBe('a0000000')
  })

  it('validates ids that arrive over IPC', () => {
    expect(isAccountId('a1bcdefg')).toBe(true)
    expect(isAccountId('a1b')).toBe(false)
    expect(isAccountId('p1bcdefg')).toBe(false)
    expect(isAccountId('../a1bcdefg')).toBe(false)
    expect(isAccountId(42)).toBe(false)
  })

  it('allocates the next free "Account N" label', () => {
    expect(allocateAccountName([], 1)).toEqual({ name: 'Account 1', counter: 2 })
    const existing = [profile({ name: 'Account 1' }), profile({ name: 'Account 2' })]
    expect(allocateAccountName(existing, 1)).toEqual({ name: 'Account 3', counter: 4 })
    // A learned identity must not be treated as a counter name.
    expect(allocateAccountName([profile({ name: 'Jane' })], 1)).toEqual({ name: 'Account 1', counter: 2 })
  })

  it('labels an account by name, then e-mail, then note', () => {
    expect(accountDisplayName(profile({ name: 'Jane' }))).toBe('Jane')
    expect(accountDisplayName(profile({ name: '', email: 'a@b.c' }))).toBe('a@b.c')
    expect(accountDisplayName(profile({ name: '', email: '', remark: 'work' }))).toBe('work')
    expect(accountDisplayName(profile({ name: '', email: '', remark: '' }))).toBe('Account')
  })

  it('orders accounts by most recent use', () => {
    const a = profile({ id: 'a1bcdefg', lastUsedAt: 1 })
    const b = profile({ id: 'a2hijklm', lastUsedAt: 9 })
    expect(sortAccounts([a, b]).map((entry) => entry.id)).toEqual(['a2hijklm', 'a1bcdefg'])
  })

  it('keeps the active id only while it names a real account', () => {
    const accounts = [profile({ id: 'a1bcdefg' }), profile({ id: 'a2hijklm' })]
    expect(resolveActiveId(accounts, 'a2hijklm')).toBe('a2hijklm')
    expect(resolveActiveId(accounts, 'agonegone')).toBe('a1bcdefg')
    expect(resolveActiveId([], 'a1bcdefg')).toBe('')
  })
})

describe('macOS security helper', () => {
  it('reads the exact item ipatool writes', () => {
    // pkg/keychain/keychain.go stores Label = KeychainServiceName and the key is
    // the literal "account" used by appstore_login.go / appstore_account_info.go.
    const args = securityReadArgs()
    expect(args).toContain(IPATOOL_KEYCHAIN_SERVICE)
    expect(args).toContain(IPATOOL_KEYCHAIN_KEY)
    expect(args).toContain('-w')
  })

  it('quotes arguments for the stdin interpreter instead of argv', () => {
    // Secrets must never reach the process table, so the write goes through
    // `security -i` with the command on stdin.
    const command = securityInteractiveCommand(['add-generic-password', '-w', 'a"b\\c'])
    expect(command).toBe('"add-generic-password" "-w" "a\\"b\\\\c"')
  })

  it('writes the account record verbatim, JSON escapes intact', () => {
    const command = securityWriteCommand(RECORD)
    expect(command).toContain('add-generic-password')
    expect(command).toContain('-U')
    expect(command).toContain(IPATOOL_KEYCHAIN_SERVICE)
    // JSON's own escapes survive: the interpreter must see the record unchanged.
    expect(command).toContain('directoryServicesIdentifier')
    const args = command.match(/"((?:[^"\\]|\\.)*)"/g) ?? []
    expect(args.length).toBeGreaterThan(6)
  })

  it('accepts only output that really parses, decoding a hex rendering', () => {
    expect(decodeSecurityOutput(RECORD)).toBe(RECORD)
    expect(decodeSecurityOutput(`${RECORD}\n`)).toBe(RECORD)
    // `security -w` hex-encodes non-printable data (macOS 12 and later).
    expect(decodeSecurityOutput(Buffer.from(RECORD, 'utf8').toString('hex'))).toBe(RECORD)
    expect(decodeSecurityOutput(`0x${Buffer.from(RECORD, 'utf8').toString('hex')}`)).toBe(RECORD)
    // Anything else must not be mistaken for a session.
    expect(decodeSecurityOutput('')).toBeNull()
    expect(decodeSecurityOutput('   \n')).toBeNull()
    expect(decodeSecurityOutput('some other password')).toBeNull()
    expect(decodeSecurityOutput('deadbeef')).toBeNull()
  })
})

describe('Linux secret-tool helper', () => {
  it('uses the same service attributes ipatool registers', () => {
    const read = secretToolReadArgs()
    expect(read[0]).toBe('lookup')
    expect(read).toContain(IPATOOL_KEYCHAIN_SERVICE)
    expect(read).toContain(IPATOOL_KEYCHAIN_KEY)

    const write = secretToolWriteArgs()
    expect(write[0]).toBe('store')
    expect(write).toContain(IPATOOL_KEYCHAIN_SERVICE)
    expect(write).toContain(IPATOOL_KEYCHAIN_KEY)
  })

  it('strips exactly one trailing newline from the secret', () => {
    expect(decodeSecretToolOutput(`${RECORD}\n`)).toBe(RECORD)
    expect(decodeSecretToolOutput(RECORD)).toBe(RECORD)
    expect(decodeSecretToolOutput('nope\n')).toBeNull()
    expect(decodeSecretToolOutput('')).toBeNull()
  })
})
