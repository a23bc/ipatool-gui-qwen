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

export interface StoredCredential {
  password: string
  /** The Apple ID this password was captured for. */
  email: string
}

type Store = Record<string, StoredCredential>

let cache: Store | null = null
let file = ''
let tmpSequence = 0
/** In-flight load, shared so concurrent first-accessors mutate ONE cache. */
let loading: Promise<Store> | null = null

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
  // Without this, two concurrent first-loaders would each build their own
  // Store object and the later assignment would drop the earlier one's
  // mutations (a lost-update race on set()).
  if (!loading) {
    loading = doLoad().finally(() => {
      loading = null
    })
  }
  return loading
}

async function doLoad(): Promise<Store> {
  if (cache) return cache
  try {
    const raw = await readFile(filePath(), 'utf8')
    const parsed = JSON.parse(raw) as Record<string, string>
    const out: Store = {}
    for (const [id, value] of Object.entries(parsed)) {
      if (typeof value !== 'string' || !value.startsWith(PREFIX)) continue
      if (!available()) continue
      try {
        const plain = safeStorage.decryptString(Buffer.from(value.slice(PREFIX.length), 'base64'))
        // Current entries are JSON ({ password, email }); legacy entries were
        // bare passwords, which JSON.parse rejects - treat that as the legacy
        // shape instead of dropping the credential.
        let decoded: { password?: unknown; email?: unknown }
        try {
          const parsed: unknown = JSON.parse(plain)
          decoded = parsed && typeof parsed === 'object' ? (parsed as { password?: unknown; email?: unknown }) : { password: plain }
        } catch {
          decoded = { password: plain }
        }
        if (typeof decoded.password === 'string' && decoded.password !== '') {
          out[id] = {
            password: decoded.password,
            email: typeof decoded.email === 'string' ? decoded.email : ''
          }
        }
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
  // m-M8: never write a silently-emptied store. Without safeStorage the
  // encoded map below would be `{}` and every stored password would vanish on
  // the next load; refusing loudly keeps the UI honest instead.
  if (!available()) {
    throw new Error(
      'System credential storage is unavailable (on Linux install libsecret / gnome-keyring); nothing was written'
    )
  }
  const store = cache ?? {}
  const encoded: Record<string, string> = {}
  for (const [id, value] of Object.entries(store)) {
    encoded[id] = PREFIX + safeStorage.encryptString(JSON.stringify(value)).toString('base64')
  }
  // Unique tmp name per write: two concurrent persist() calls sharing one
  // fixed name would race, and the second rename() would fail with ENOENT.
  tmpSequence += 1
  const tmp = `${filePath()}.${process.pid}.${Date.now()}.${tmpSequence}.tmp`
  try {
    await writeFile(tmp, JSON.stringify(encoded), { encoding: 'utf8', mode: 0o600 })
    await rename(tmp, filePath())
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {})
    throw error
  }
}

export async function set(profileId: string, password: string, email: string): Promise<void> {
  if (!available()) {
    throw new Error(
      'Passwords cannot be stored on this system: safeStorage encryption is unavailable ' +
        '(on Linux install libsecret / gnome-keyring). Sign in manually after switching accounts.'
    )
  }
  const store = await load()
  store[profileId] = { password, email: email.trim().toLowerCase() }
  await persist()
}

export async function clear(profileId: string): Promise<void> {
  const store = await load()
  delete store[profileId]
  if (!available()) {
    // Nothing readable can exist without encryption; drop the file outright.
    cache = store
    await rm(filePath(), { force: true })
    return
  }
  await persist()
}

export async function get(profileId: string): Promise<StoredCredential | null> {
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
  if (!available()) {
    cache = store
    await rm(filePath(), { force: true })
    return
  }
  await persist()
}

export async function wipe(): Promise<void> {
  // null (not {}) so the next load() re-reads from disk instead of
  // short-circuiting on a truthy empty cache.
  cache = null
  await rm(filePath(), { force: true })
}
