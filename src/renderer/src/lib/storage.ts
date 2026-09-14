/**
 * Safe localStorage helpers.
 *
 * The renderer can be loaded from file:// where storage may be restricted, and a
 * quota or security error must never break the app - these wrappers degrade to
 * in-memory instead.
 */

const memory = new Map<string, string>()

let usable: boolean | null = null

function storageAvailable(): boolean {
  if (usable !== null) return usable
  try {
    const probe = '__ipatool_gui_probe__'
    window.localStorage.setItem(probe, '1')
    window.localStorage.removeItem(probe)
    usable = true
  } catch {
    usable = false
  }
  return usable
}

export function readStorage(key: string): string | null {
  if (!storageAvailable()) return memory.get(key) ?? null
  try {
    return window.localStorage.getItem(key)
  } catch {
    return memory.get(key) ?? null
  }
}

export function writeStorage(key: string, value: string): void {
  memory.set(key, value)
  if (!storageAvailable()) return
  try {
    window.localStorage.setItem(key, value)
  } catch {
    /* quota exceeded - the in-memory copy is enough for this session */
  }
}

export function removeStorage(key: string): void {
  memory.delete(key)
  if (!storageAvailable()) return
  try {
    window.localStorage.removeItem(key)
  } catch {
    /* ignore */
  }
}

export function readJson<T>(key: string, fallback: T): T {
  const raw = readStorage(key)
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function writeJson(key: string, value: unknown): void {
  try {
    writeStorage(key, JSON.stringify(value))
  } catch {
    /* not serialisable - skip */
  }
}
