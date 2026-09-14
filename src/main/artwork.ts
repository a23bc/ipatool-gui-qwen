/**
 * App artwork.
 *
 * ipatool's own output carries no icon URL, so artwork is fetched from Apple's
 * public iTunes Lookup endpoint. That request has to happen in the main process:
 * the endpoint sends no CORS headers, so a renderer-side fetch would always fail.
 *
 * Results are cached twice - an in-memory LRU for the current session and a disk
 * cache that survives restarts - and identical concurrent requests are collapsed
 * into one network call. Images are returned as data URLs so the renderer needs
 * no custom protocol or relaxed web security to display them.
 */

import { mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'
import { fetchJson } from './http'
import { settingsStore } from './settings'

interface ItunesLookupResponse {
  resultCount?: number
  results?: Array<{ artworkUrl100?: string; artworkUrl512?: string; artworkUrl60?: string }>
}

const MEMORY_LIMIT = 400
const MAX_CONCURRENCY = 6
const LOOKUP_TIMEOUT_MS = 12_000

/** Requests larger artwork than the 100px thumbnail Apple returns by default. */
function upscale(url: string, size = 400): string {
  return url.replace(/\/\d+x\d+([a-z]{0,2})\./i, `/${size}x${size}$1.`)
}

export class ArtworkCache {
  private readonly memory = new Map<string, string | null>()
  private readonly inflight = new Map<string, Promise<string | null>>()
  private readonly negative = new Map<string, number>()
  private active = 0
  private readonly waiting: Array<() => void> = []
  private dir: string | null = null

  private cacheDir(): string {
    if (!this.dir) this.dir = path.join(app.getPath('userData'), 'artwork')
    return this.dir
  }

  private key(appId: number, country: string): string {
    return `${appId}_${country.toLowerCase()}`
  }

  private diskPath(key: string): string {
    return path.join(this.cacheDir(), `${key}.img`)
  }

  private touchMemory(key: string, value: string | null): void {
    // Re-insert to keep Map iteration order == LRU order.
    this.memory.delete(key)
    this.memory.set(key, value)
    while (this.memory.size > MEMORY_LIMIT) {
      const oldest = this.memory.keys().next()
      if (oldest.done) break
      this.memory.delete(oldest.value)
    }
  }

  async get(appId: number, country?: string): Promise<string | null> {
    if (!settingsStore.getInternal().artworkEnabled) return null
    if (!Number.isFinite(appId) || appId <= 0) return null

    const cc = (country ?? settingsStore.getInternal().artworkCountry ?? 'us').toLowerCase()
    const cacheKey = this.key(appId, cc)

    if (this.memory.has(cacheKey)) return this.memory.get(cacheKey) ?? null

    // Negative results are cached for a while so a missing icon is not retried
    // on every scroll-through of a long list.
    const failedAt = this.negative.get(cacheKey)
    if (failedAt && Date.now() - failedAt < 10 * 60_000) return null

    const pending = this.inflight.get(cacheKey)
    if (pending) return pending

    const task = this.load(cacheKey, appId, cc).finally(() => {
      this.inflight.delete(cacheKey)
    })
    this.inflight.set(cacheKey, task)
    return task
  }

  private async load(cacheKey: string, appId: number, country: string): Promise<string | null> {
    const disk = this.diskPath(cacheKey)
    try {
      const cached = await readFile(disk)
      const dataUrl = `data:image/jpeg;base64,${cached.toString('base64')}`
      this.touchMemory(cacheKey, dataUrl)
      return dataUrl
    } catch {
      /* not cached yet */
    }

    await this.acquire()
    try {
      const url = `https://itunes.apple.com/lookup?id=${encodeURIComponent(String(appId))}&country=${encodeURIComponent(country)}`
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS)
      timer.unref?.()

      let data: ItunesLookupResponse
      try {
        data = await fetchJson<ItunesLookupResponse>(url, { signal: controller.signal })
      } finally {
        clearTimeout(timer)
      }

      const first = data?.results?.[0]
      const raw = first?.artworkUrl512 ?? first?.artworkUrl100 ?? first?.artworkUrl60
      if (!raw) {
        this.negative.set(cacheKey, Date.now())
        this.touchMemory(cacheKey, null)
        return null
      }

      const bytes = await this.fetchImage(upscale(raw))
      if (!bytes) {
        this.negative.set(cacheKey, Date.now())
        this.touchMemory(cacheKey, null)
        return null
      }

      await mkdir(this.cacheDir(), { recursive: true })
      await writeFile(disk, bytes).catch(() => {})
      const dataUrl = `data:image/jpeg;base64,${Buffer.from(bytes).toString('base64')}`
      this.touchMemory(cacheKey, dataUrl)
      return dataUrl
    } catch {
      this.negative.set(cacheKey, Date.now())
      this.touchMemory(cacheKey, null)
      return null
    } finally {
      this.release()
    }
  }

  private async fetchImage(url: string): Promise<Uint8Array | null> {
    try {
      const response = await fetch(url, { redirect: 'follow' })
      if (!response.ok) return null
      return new Uint8Array(await response.arrayBuffer())
    } catch {
      return null
    }
  }

  private acquire(): Promise<void> {
    if (this.active < MAX_CONCURRENCY) {
      this.active += 1
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      this.waiting.push(() => {
        this.active += 1
        resolve()
      })
    })
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1)
    const next = this.waiting.shift()
    if (next) next()
  }

  /** Drops the on-disk cache; returns the number of files removed. */
  async clear(): Promise<number> {
    this.memory.clear()
    this.negative.clear()
    let removed = 0
    try {
      const names = await readdir(this.cacheDir())
      for (const name of names) {
        await rm(path.join(this.cacheDir(), name), { force: true })
        removed += 1
      }
    } catch {
      /* nothing cached yet */
    }
    return removed
  }
}

export const artworkCache = new ArtworkCache()
