/**
 * Per-profile stored Apple ID passwords.
 *
 * Why this exists: upstream ipatool keeps credentials in the *system* keyring
 * (macOS Keychain / Linux SecretService) under one fixed service name, so on
 * those platforms only ONE session can exist machine-wide regardless of state
 * directories. Switching accounts therefore means re-logging-in, and doing that
 * painlessly requires us to hold the password.
 *
 * Security posture:
 *  - encrypted with Electron safeStorage (DPAPI / Keychain / libsecret);
 *  - kept in a separate file from settings.json so a settings dump never carries
 *    credential material;
 *  - opt-in per profile, always indicated in the UI, always forgettable;
 *  - never sent anywhere except as `-p` to the local ipatool process, and
 *    redacted from every log line by the runner.
 */

import { readFile, rename, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { app, safeStorage } from 'electron'

const FILE_NAME = 'credentials.json'
const PREFIX = 'enc:v1:'

type Store = Record<string, string>

let cache: Store | null = null
let file = ''

function filePath(): string {
  if (!file) file = path.join(app.getPath('userData'), FILE_NAME)
  return file
}

function available(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

async function load(): Promise<Store> {
  if (cache) return cache
  try {
    const raw = await readFile(filePath(), 'utf8')
    const parsed = JSON.parse(raw) as Record<string, string>
    const out: Store = {}
    for (const [id, value] of Object.entries(parsed)) {
      if (typeof value !== 'string' || !value.startsWith(PREFIX)) continue
      if (!available()) continue
      try {
        out[id] = safeStorage.decryptString(Buffer.from(value.slice(PREFIX.length), 'base64'))
      } catch {
        /* unreadable entry: drop it rather than fail the whole store */
      }
    }
    cache = out
  } catch {
    cache = {}
  }
  return cache
}

async function persist(): Promise<void> {
  const store = cache ?? {}
  const encoded: Record<string, string> = {}
  if (available()) {
    for (const [id, value] of Object.entries(store)) {
      encoded[id] = PREFIX + safeStorage.encryptString(value).toString('base64')
    }
  }
  const tmp = `${filePath()}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(encoded), { encoding: 'utf8', mode: 0o600 })
  await rename(tmp, filePath())
}

export async function set(profileId: string, password: string): Promise<void> {
  const store = await load()
  store[profileId] = password
  await persist()
}

export async function clear(profileId: string): Promise<void> {
  const store = await load()
  delete store[profileId]
  await persist()
}

export async function get(profileId: string): Promise<string | null> {
  const store = await load()
  return store[profileId] ?? null
}

export async function has(profileId: string): Promise<boolean> {
  return (await get(profileId)) !== null
}

/** Used when a profile is removed so no orphan credential survives. */
export async function forgetAllExcept(ids: string[]): Promise<void> {
  const store = await load()
  for (const id of Object.keys(store)) {
    if (!ids.includes(id)) delete store[id]
  }
  await persist()
}

export async function wipe(): Promise<void> {
  cache = {}
  await rm(filePath(), { force: true })
}
