/**
 * Tests for the account registry and the session probe.
 *
 * This is where the multi-account contract actually lives, so the cases below are
 * the ones that would silently corrupt a session if they regressed:
 *
 *  - which environment selects an account (and that the legacy `~/.ipatool`
 *    fallback can never be reached);
 *  - that a machine-wide credential slot is read before it is written, and that
 *    the lease is released even when the command throws;
 *  - that a shared slot is serialised, because two accounts cannot be "current"
 *    at the same time;
 *  - that `verifySession` distinguishes "signed out" from "somebody else's
 *    session" from "could not check", instead of collapsing them into one error.
 */
import { mkdirSync, mkdtempSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccountInfo } from '@shared/types'

const mocks = vi.hoisted(() => ({
  root: '',
  home: '',
  encryptionAvailable: true,
  slot: null as string | null,
  bridgeAvailable: true,
  writes: [] as string[],
  reads: 0
}))

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => path.join(mocks.root, name),
    isReady: () => false,
    getLocale: () => 'en-US'
  },
  safeStorage: {
    isEncryptionAvailable: () => mocks.encryptionAvailable,
    encryptString: (value: string) => Buffer.from(`enc<${value}>`, 'utf8'),
    decryptString: (buffer: Buffer) => {
      const text = buffer.toString('utf8')
      const match = text.match(/^enc<([\s\S]*)>$/)
      if (!match) throw new Error('bad ciphertext')
      return match[1] ?? ''
    }
  }
}))

// The legacy-directory test needs a home directory of its own: `~/.ipatool` is
// the one path the app may move, and a test must never touch the real one.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  const homedir = (): string => mocks.home
  return { ...actual, default: { ...actual, homedir }, homedir }
})

vi.mock('@main/keyringSlot', () => ({
  slotBridge: async () => ({
    kind: 'macos-security',
    tool: '/usr/bin/security',
    available: mocks.bridgeAvailable,
    detail: 'test bridge'
  }),
  readSlot: async () => {
    mocks.reads += 1
    return { raw: mocks.slot, bridge: { available: mocks.bridgeAvailable } }
  },
  writeSlot: async (data: string) => {
    mocks.writes.push(data)
    mocks.slot = data
    return { ok: true, detail: '' }
  }
}))

const accountInfo = vi.hoisted(() => ({
  impl: async (): Promise<AccountInfo> => ({ name: 'Me', email: 'me@example.com' })
}))

vi.mock('@main/api', () => ({
  // Mirrors the real signature closely enough that call sites keep type-checking
  // against the production class.
  ApiError: class ApiError extends Error {
    readonly code: string
    constructor(message: string, code: string, _taskId = '', _exitCode: number | null = null) {
      super(message)
      this.name = 'ApiError'
      this.code = code
    }
  },
  ipatoolApi: {
    accountInfo: () => accountInfo.impl()
  }
}))

import {
  AccountError,
  AccountRegistry,
  accounts,
  accountsRoot,
  homeDirFor,
  stateDirFor
} from '@main/accounts'
import { ApiError } from '@main/api'
import { settingsStore } from '@main/settings'
import { verifySession } from '@main/session'

function registry(): AccountRegistry {
  const store = settingsStore
  store.init()
  return new AccountRegistry()
}

function record(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    email: 'me@example.com',
    name: 'Me',
    passwordToken: 'tok',
    directoryServicesIdentifier: '12345',
    storeFront: '143441-1,29',
    password: 'hunter2',
    pod: 'p1',
    ...over
  })
}

beforeEach(() => {
  mocks.root = mkdtempSync(path.join(os.tmpdir(), 'ipatool-accounts-'))
  mocks.home = mkdtempSync(path.join(os.tmpdir(), 'ipatool-home-'))
  // Electron creates userData before anything writes to it; a fire-and-forget
  // settings save from the previous test would otherwise land here and complain.
  mkdirSync(path.join(mocks.root, 'userData'), { recursive: true })
  mocks.encryptionAvailable = true
  mocks.slot = null
  mocks.bridgeAvailable = true
  mocks.writes = []
  mocks.reads = 0
})

/** Reads an account that the test just created, failing loudly if it is gone. */
function required<T>(value: T | null): T {
  if (value === null) throw new Error('expected a value')
  return value
}

describe('AccountRegistry: naming and env', () => {
  it('materialises exactly one account on init', async () => {
    const reg = registry()
    await reg.init()
    const list = reg.list()
    expect(list).toHaveLength(1)
    expect(list[0]?.name).toBe('Account 1')
    expect(reg.activeId).toBe(list[0]?.id)
    // A second init must not add another account.
    await reg.init()
    expect(reg.list()).toHaveLength(1)
  })

  it('lays each account out under its own state and home directory', async () => {
    const reg = registry()
    await reg.init()
    const profile = reg.active()
    expect(stateDirFor(profile.id).startsWith(accountsRoot())).toBe(true)
    expect(homeDirFor(profile.id).startsWith(accountsRoot())).toBe(true)
    expect(stateDirFor(profile.id)).not.toBe(homeDirFor(profile.id))
  })

  it('selects the session with XDG_STATE_HOME and sandboxes the home directory', async () => {
    const reg = registry()
    await reg.init()
    const profile = reg.active()
    const env = reg.envFor(profile)

    // cmd/state_directory.go accepts XDG_STATE_HOME only when it is absolute, so
    // the appends it makes have to land somewhere real.
    expect(path.isAbsolute(env.XDG_STATE_HOME ?? '')).toBe(true)
    expect(env.XDG_STATE_HOME).toBe(stateDirFor(profile.id))

    // Upstream prefers $HOME/.ipatool whenever it exists, which would put every
    // account back on one session - hence the sandbox.
    const home = homeDirFor(profile.id)
    if (process.platform === 'win32') {
      expect(`${env.HOMEDRIVE}${env.HOMEPATH}`).toBe(home)
      expect(env.HOME).toBeUndefined()
    } else {
      expect(env.HOME).toBe(home)
    }
  })

  it('drops the home sandbox when the user turns it off', async () => {
    const reg = registry()
    await reg.init()
    settingsStore.update({ isolateSessionHome: false })
    const env = reg.envFor(reg.active())
    expect(env.HOME).toBeUndefined()
    expect(env.HOMEDRIVE).toBeUndefined()
    expect(env.XDG_STATE_HOME).toBeDefined()
  })

  it('adopts an existing ~/.ipatool session when the sandbox is off', async () => {
    settingsStore.init()
    settingsStore.update({ isolateSessionHome: false })

    // With the sandbox off, upstream would leave this directory in place and fall
    // back to it for *every* account - the app adopts it into the first one.
    const legacy = path.join(mocks.home, '.ipatool')
    await mkdir(legacy, { recursive: true })
    await writeFile(path.join(legacy, 'cookies'), 'legacy-session', 'utf8')

    const reg = new AccountRegistry()
    await reg.init()

    const adopted = path.join(stateDirFor(reg.active().id), 'ipatool', 'cookies')
    await expect(readFile(adopted, 'utf8')).resolves.toBe('legacy-session')
    await expect(stat(legacy)).rejects.toThrow()
    expect((await reg.snapshot()).legacy?.adopted).toBe(true)
  })

  it('parks a legacy session instead of merging it when the account already has state', async () => {
    settingsStore.init()
    settingsStore.update({ isolateSessionHome: false })
    const legacy = path.join(mocks.home, '.ipatool')
    await mkdir(legacy, { recursive: true })

    // First run adopts it ...
    const first = new AccountRegistry()
    await first.init()
    // ... so a second, re-created legacy directory can only be parked, never
    // merged into the account that already owns a session.
    await mkdir(path.join(legacy, 'x'), { recursive: true })
    const second = new AccountRegistry()
    await second.init()

    const snapshot = await second.snapshot()
    expect(snapshot.legacy?.adopted).toBe(false)
    expect(snapshot.legacy?.quarantined).toContain(accountsRoot())
  })
})

describe('AccountRegistry: leases', () => {
  it('hands out an environment and a per-account passphrase without locking on Windows', async () => {
    const reg = registry()
    await reg.init()
    // The file backend is scoped to the state directory, so no slot is involved.
    reg.setCredentialStore(reg.activeId, 'file')

    const lease = await reg.acquire()
    expect(lease.env.XDG_STATE_HOME).toBe(stateDirFor(lease.account.id))
    expect(lease.passphrase.length).toBeGreaterThan(20)
    expect(mocks.writes).toHaveLength(0)
    lease.release()
  })

  it('generates a distinct passphrase per account and reuses it afterwards', async () => {
    const reg = registry()
    await reg.init()
    const first = await reg.acquire()
    const second = await reg.acquire()
    expect(second.passphrase).toBe(first.passphrase)

    const other = reg.add('')
    const third = await reg.acquire(other.id)
    expect(third.passphrase).not.toBe(first.passphrase)
  })

  it('leaves a slot that already holds this account alone', async () => {
    const reg = registry()
    await reg.init()
    const id = reg.activeId
    reg.markIdentity(id, { email: 'me@example.com', dsid: '12345', name: 'Me' })
    reg.setCredentialStore(id, 'os')
    await reg.saveSnapshot(required(reg.get(id)), record())
    mocks.slot = record()

    const lease = await reg.acquire(id)
    expect(mocks.writes).toHaveLength(0)
    lease.release()
  })

  it('restores this account into a slot that holds another one', async () => {
    const reg = registry()
    await reg.init()
    const id = reg.activeId
    reg.markIdentity(id, { email: 'me@example.com', dsid: '12345', name: 'Me' })
    reg.setCredentialStore(id, 'os')
    await reg.saveSnapshot(required(reg.get(id)), record())
    mocks.slot = record({ email: 'someone.else@example.com', directoryServicesIdentifier: '999' })

    const lease = await reg.acquire(id)
    expect(mocks.writes).toEqual([record()])
    lease.release()
  })

  it('keeps the incumbent account recoverable before taking the slot over', async () => {
    const reg = registry()
    await reg.init()
    const first = reg.activeId
    reg.markIdentity(first, { email: 'me@example.com', dsid: '12345', name: 'Me' })
    reg.setCredentialStore(first, 'os')
    await reg.saveSnapshot(required(reg.get(first)), record())

    // A second account is the slot's current occupant and has no saved copy yet.
    const second = reg.add('')
    reg.markIdentity(second.id, { email: 'other@example.com', dsid: '777', name: 'Other' })
    reg.setCredentialStore(second.id, 'os')
    const secondRecord = record({ email: 'other@example.com', directoryServicesIdentifier: '777' })
    mocks.slot = secondRecord

    const lease = await reg.acquire(first)
    // Switching away must not throw the incumbent's credentials away: on a
    // shared-slot platform the account *is* the slot entry.
    expect(await reg.readSnapshot(required(reg.get(second.id)))).toBe(secondRecord)
    expect(mocks.writes).toEqual([record()])
    lease.release()
  })

  it('refuses to run when the slot holds a foreign session and nothing was saved', async () => {
    const reg = registry()
    await reg.init()
    const profile = reg.active()
    reg.setCredentialStore(profile.id, 'os')
    mocks.slot = record({ email: 'someone.else@example.com' })

    await expect(reg.acquire(profile.id)).rejects.toBeInstanceOf(AccountError)
    expect(mocks.writes).toHaveLength(0)
  })

  it('does not overwrite a slot it cannot explain', async () => {
    const reg = registry()
    await reg.init()
    const profile = reg.active()
    reg.setCredentialStore(profile.id, 'os')
    // No snapshot and an unreadable slot: guessing here would throw away whatever
    // the terminal CLI had stored.
    mocks.slot = null
    await expect(reg.acquire(profile.id)).rejects.toMatchObject({ code: 'session-mismatch' })
    expect(mocks.writes).toHaveLength(0)
  })

  it('serialises leases while the slot is shared', async () => {
    const reg = registry()
    await reg.init()
    const id = reg.activeId
    reg.markIdentity(id, { email: 'me@example.com', dsid: '12345', name: 'Me' })
    reg.setCredentialStore(id, 'os')
    await reg.saveSnapshot(required(reg.get(id)), record())
    mocks.slot = record()

    const held = await reg.acquire(id)
    let second = false
    const pending = reg.acquire(id).then((lease) => {
      second = true
      lease.release()
    })

    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(second).toBe(false) // the slot is still reserved
    held.release()
    await pending
    expect(second).toBe(true)
  })

  it('releases the slot when the caller finishes', async () => {
    const reg = registry()
    await reg.init()
    const id = reg.activeId
    reg.markIdentity(id, { email: 'me@example.com', dsid: '12345', name: 'Me' })
    reg.setCredentialStore(id, 'os')
    await reg.saveSnapshot(required(reg.get(id)), record())
    mocks.slot = record()

    // This is what api.execute() does in its `finally`: a leaked release would
    // wedge every later command behind the lock.
    const lease = await reg.acquire(id)
    lease.release()
    const again = await reg.acquire(id)
    again.release()
  })
})

describe('AccountRegistry: saved records', () => {
  it('stores the record encrypted and never in the clear', async () => {
    const reg = registry()
    await reg.init()
    const profile = reg.active()
    expect(await reg.saveSnapshot(profile, record())).toBe(true)
    expect(await reg.readSnapshot(profile)).toBe(record())

    const file = path.join(accountsRoot(), profile.id, 'account.enc')
    const raw = await readFile(file, 'utf8')
    // The record carries the Apple ID password - upstream marshals the whole
    // Account struct - so a cleartext copy would defeat the keyring entirely.
    expect(raw).not.toContain('hunter2')
    expect(raw.startsWith('enc:v1:')).toBe(true)
  })

  it('refuses to save anything that is not an account record', async () => {
    const reg = registry()
    await reg.init()
    expect(await reg.saveSnapshot(reg.active(), 'not json')).toBe(false)
    expect(await reg.saveSnapshot(reg.active(), '{}')).toBe(false)
  })

  it('refuses to write a record when encryption is unavailable', async () => {
    const reg = registry()
    await reg.init()
    mocks.encryptionAvailable = false
    expect(await reg.saveSnapshot(reg.active(), record())).toBe(false)
    expect(await reg.readSnapshot(reg.active())).toBeNull()
  })

  it('only adopts a slot occupant that is not clearly somebody else', async () => {
    const reg = registry()
    await reg.init()
    const profile = reg.active()
    reg.markIdentity(profile.id, { email: 'me@example.com', dsid: '', name: 'Me' })
    const known = required(reg.get(profile.id))

    mocks.slot = record({ email: 'someone.else@example.com' })
    expect(await reg.captureSlotIdentity(known)).toBe(false)

    mocks.slot = record()
    expect(await reg.captureSlotIdentity(known)).toBe(true)
    expect(await reg.readSnapshot(known)).toBe(record())
  })
})

describe('AccountRegistry: identity and removal', () => {
  it('adopts the learned name for an auto-generated label only', async () => {
    const reg = registry()
    await reg.init()
    const profile = reg.active()
    reg.markIdentity(profile.id, { email: 'me@example.com', dsid: '12345', name: 'Jane' })
    expect(reg.get(profile.id)?.name).toBe('Jane')
    expect(reg.get(profile.id)?.dsid).toBe('12345')

    reg.setRemark(profile.id, 'work')
    reg.markIdentity(profile.id, { email: 'me2@example.com', dsid: '12345', name: 'Someone' })
    // A label the user set is never overwritten by a later sign-in.
    expect(reg.get(profile.id)?.name).toBe('Jane')
    expect(reg.get(profile.id)?.remark).toBe('work')
  })

  it('removes only its own managed directory', async () => {
    const reg = registry()
    await reg.init()
    const profile = reg.add('')
    await reg.ensureDirs(profile)
    const dir = path.join(accountsRoot(), profile.id)

    const removed = await reg.remove(profile.id)
    expect(removed.removedDir).toBe(true)
    await expect(stat(dir)).rejects.toThrow()
    expect(reg.get(profile.id)).toBeNull()
    expect(reg.list()).toHaveLength(1)
  })

  it('replaces the last account instead of leaving none', async () => {
    const reg = registry()
    await reg.init()
    const only = reg.active()
    await reg.remove(only.id)
    expect(reg.list()).toHaveLength(1)
    expect(reg.list()[0]?.id).not.toBe(only.id)
    expect(reg.activeId).toBe(reg.list()[0]?.id)
  })
})

/**
 * The session layer talks to the process-wide registry, not to an instance, so
 * these cases use the same singleton the app does - with the settings store reset
 * first, since that is where the account list actually lives.
 */
describe('verifySession', () => {
  beforeEach(async () => {
    settingsStore.init()
    await accounts.init()
  })

  it('adopts the identity a session reports', async () => {
    accountInfo.impl = async () => ({ name: 'Me', email: 'Me@Example.com' })

    const id = accounts.activeId
    const check = await verifySession(id)
    expect(check.status).toBe('ok')
    expect(accounts.get(id)?.email).toBe('Me@Example.com')
    expect(accounts.get(id)?.name).toBe('Me')
  })

  it('treats a missing keyring item as "signed out", not as a failure', async () => {
    accountInfo.impl = async () => {
      // The exact wording both keyring backends produce for a missing item, which
      // `classifyError` maps to `not-signed-in`.
      throw new ApiError(
        'failed to get account: failed to get item: The specified item could not be found in the keyring',
        'not-signed-in',
        't1',
        1
      )
    }

    const id = accounts.activeId
    const check = await verifySession(id)
    expect(check.status).toBe('signed-out')
    expect(accounts.get(id)?.email).toBe('')
  })

  it('flags a session that answers as somebody else', async () => {
    const id = accounts.create('').id
    accounts.markIdentity(id, { email: 'me@example.com', dsid: '', name: 'Me' })
    accountInfo.impl = async () => ({ name: 'Them', email: 'them@example.com' })

    const check = await verifySession(id)
    expect(check.status).toBe('foreign')
    expect(check.expected).toBe('me@example.com')
    const view = (await accounts.snapshot()).accounts.find((entry) => entry.id === id)
    expect(view?.conflict).toBe('foreign-session')
    // The recorded identity is left alone: the conflict is reported, not "fixed".
    expect(accounts.get(id)?.email).toBe('me@example.com')
  })

  it('reports an unreachable engine as unverifiable', async () => {
    accountInfo.impl = async () => {
      throw new Error('ipatool is not installed')
    }
    const check = await verifySession(accounts.activeId)
    expect(check.status).toBe('unavailable')
    expect(check.message).toContain('not installed')
  })
})
