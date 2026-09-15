/**
 * credentials.ts tests: safeStorage round-trips, the legacy bare-password
 * shape, the "no encryption -> refuse to store" policy and concurrent writes.
 *
 * safeStorage and app.getPath are mocked; the store file lives in a temp dir.
 */
import { readFileSync } from 'node:fs'
import { writeFile, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  root: '',
  available: true
}))

// The credentials module memoizes its file path on first use, so the root must
// be fixed for the whole file - not re-created per test.
const { mkdtempSync: makeRoot } = await import('node:fs')
mocks.root = makeRoot(path.join(os.tmpdir(), 'ipatool-creds-'))

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => path.join(mocks.root, name),
    isReady: () => false
  },
  safeStorage: {
    isEncryptionAvailable: () => mocks.available,
    encryptString: (value: string) => Buffer.from(`mock-enc<${value}>`, 'utf8'),
    decryptString: (buffer: Buffer) => {
      const text = buffer.toString('utf8')
      const match = text.match(/^mock-enc<([\s\S]*)>$/)
      if (!match) throw new Error('bad ciphertext')
      return match[1] ?? ''
    }
  }
}))

import * as credentials from '@main/credentials'

const PREFIX = 'enc:v1:'

function credentialsFile(): string {
  return path.join(mocks.root, 'userData', 'credentials.json')
}

function encrypt(plain: string): string {
  return PREFIX + Buffer.from(`mock-enc<${plain}>`, 'utf8').toString('base64')
}

beforeEach(async () => {
  mocks.available = true
  // Reset the module-level cache and remove any previous file.
  await credentials.wipe()
  await mkdir(path.dirname(credentialsFile()), { recursive: true })
})

describe('credentials store', () => {
  it('round-trips a password through safeStorage encryption', async () => {
    await credentials.set('p1', 'hunter2', 'Me@Example.COM ')
    const stored = await credentials.get('p1')
    expect(stored).toEqual({ password: 'hunter2', email: 'me@example.com' })
    expect(await credentials.has('p1')).toBe(true)
    expect(await credentials.has('p2')).toBe(false)
  })

  it('stores ciphertext on disk, never the plaintext password', async () => {
    await credentials.set('p1', 'sup3r-s3cret!', 'me@example.com')
    const raw = readFileSync(credentialsFile(), 'utf8')
    expect(raw).not.toContain('sup3r-s3cret!')
    expect(JSON.parse(raw).p1.startsWith(PREFIX)).toBe(true)
  })

  it('clear() removes one entry and keeps the others', async () => {
    await credentials.set('p1', 'a-password', 'a@example.com')
    await credentials.set('p2', 'b-password', 'b@example.com')
    await credentials.clear('p1')
    expect(await credentials.get('p1')).toBeNull()
    expect((await credentials.get('p2'))?.password).toBe('b-password')
  })

  it('reads legacy bare-password entries (no JSON envelope)', async () => {
    // Pre-JSON builds encrypted the raw password string; JSON.parse on such a
    // value throws, and the loader must treat the plaintext as the password
    // instead of dropping the credential.
    await writeFile(
      credentialsFile(),
      JSON.stringify({ legacy: encrypt('bare-password') }),
      'utf8'
    )
    expect(await credentials.get('legacy')).toEqual({ password: 'bare-password', email: '' })
  })

  it('reads JSON entries without an email field', async () => {
    await writeFile(
      credentialsFile(),
      JSON.stringify({ p: encrypt(JSON.stringify({ password: 'pw123456' })) }),
      'utf8'
    )
    expect(await credentials.get('p')).toEqual({ password: 'pw123456', email: '' })
  })

  it('drops unreadable / malformed entries without failing the store', async () => {
    await writeFile(
      credentialsFile(),
      JSON.stringify({
        good: encrypt(JSON.stringify({ password: 'good-pw', email: 'g@example.com' })),
        junk: 'not-encrypted-at-all',
        broken: `${PREFIX}!!!not-base64!!!`
      }),
      'utf8'
    )
    expect((await credentials.get('good'))?.password).toBe('good-pw')
    expect(await credentials.get('junk')).toBeNull()
    expect(await credentials.get('broken')).toBeNull()
  })

  it('set() refuses to store anything when safeStorage is unavailable (m-M8)', async () => {
    mocks.available = false
    await expect(credentials.set('p1', 'hunter2', 'me@example.com')).rejects.toThrow(
      /unavailable/i
    )
  })

  it('clear() still works when encryption is unavailable', async () => {
    await credentials.set('p1', 'hunter2', 'me@example.com')
    mocks.available = false
    await expect(credentials.clear('p1')).resolves.toBeUndefined()
    expect(await credentials.get('p1')).toBeNull()
  })

  it('survives concurrent set() calls (unique tmp names, m-M6)', async () => {
    await Promise.all([
      credentials.set('a', 'password-a', 'a@example.com'),
      credentials.set('b', 'password-b', 'b@example.com'),
      credentials.set('c', 'password-c', 'c@example.com')
    ])
    expect((await credentials.get('a'))?.password).toBe('password-a')
    expect((await credentials.get('b'))?.password).toBe('password-b')
    expect((await credentials.get('c'))?.password).toBe('password-c')
  })

  it('forgetAllExcept() prunes orphaned profiles', async () => {
    await credentials.set('keep', 'pw-keep-1', 'keep@example.com')
    await credentials.set('drop', 'pw-drop-1', 'drop@example.com')
    await credentials.forgetAllExcept(['keep'])
    expect(await credentials.get('keep')).not.toBeNull()
    expect(await credentials.get('drop')).toBeNull()
  })

  it('wipe() empties the cache and deletes the file', async () => {
    await credentials.set('p1', 'hunter2', 'me@example.com')
    await credentials.wipe()
    expect(await credentials.get('p1')).toBeNull()
  })
})
