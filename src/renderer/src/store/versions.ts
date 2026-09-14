/**
 * Version history for a single app.
 *
 * ipatool's `list-versions` returns opaque external identifiers. Turning those
 * into human version numbers needs one `get-version-metadata` call *per version*,
 * which is slow and rate-limit-prone - so it is opt-in ("Resolve names"), runs
 * with bounded concurrency, and is cached to localStorage keyed by app + platform.
 */

import { create } from 'zustand'
import type { Platform, StoreApp, VersionMetadata } from '@shared/types'
import { readJson, writeJson } from '@renderer/lib/storage'

const CACHE_KEY = 'versions.metadata'
const RESOLVE_CONCURRENCY = 3

type MetadataCache = Record<string, VersionMetadata>

function cacheKeyFor(appId: number, bundleID: string, platform: Platform): string {
  return `${appId || bundleID}@${platform || 'auto'}`
}

function loadCache(): MetadataCache {
  return readJson<MetadataCache>(CACHE_KEY, {})
}

let diskCache: MetadataCache = loadCache()

function saveCache(): void {
  // Keep the on-disk cache bounded; oldest entries are simply dropped by size.
  const keys = Object.keys(diskCache)
  if (keys.length > 4000) {
    const next: MetadataCache = {}
    for (const key of keys.slice(keys.length - 4000)) next[key] = diskCache[key]
    diskCache = next
  }
  writeJson(CACHE_KEY, diskCache)
}

export interface VersionsState {
  app: StoreApp | null
  platform: Platform
  ids: string[]
  /** externalVersionID -> metadata */
  meta: Record<string, VersionMetadata>
  loading: boolean
  resolving: boolean
  resolvedCount: number
  totalToResolve: number
  error: { message: string; hint: string | null; code: string | null } | null

  load: (app: StoreApp, platform?: Platform) => Promise<void>
  resolveAll: () => Promise<void>
  resolveOne: (externalVersionID: string) => Promise<VersionMetadata | null>
  close: () => void
}

export const useVersionsStore = create<VersionsState>()((set, get) => ({
  app: null,
  platform: '',
  ids: [],
  meta: {},
  loading: false,
  resolving: false,
  resolvedCount: 0,
  totalToResolve: 0,
  error: null,

  async load(app, platform) {
    const effectivePlatform = platform ?? ''
    set({
      app,
      platform: effectivePlatform,
      ids: [],
      meta: {},
      loading: true,
      error: null,
      resolvedCount: 0,
      totalToResolve: 0
    })

    const result = await window.api.listVersions(
      { appId: app.id || undefined, bundleID: app.bundleID || undefined },
      effectivePlatform || undefined
    )

    if (!result.ok) {
      set({
        loading: false,
        error: { message: result.error, hint: result.hint, code: result.code }
      })
      return
    }

    // Seed from the disk cache so previously resolved apps are instant.
    const cacheKey = cacheKeyFor(app.id, app.bundleID, effectivePlatform)
    const cached = diskCache[cacheKey]
    const ids = result.data.externalVersionIdentifiers
    const seeded: Record<string, VersionMetadata> = {}
    if (cached && ids.includes(cached.externalVersionID)) {
      seeded[cached.externalVersionID] = cached
    }

    set({ loading: false, ids, meta: seeded, error: null })
  },

  async resolveOne(externalVersionID) {
    const { app, platform, meta } = get()
    if (!app) return null
    if (meta[externalVersionID]) return meta[externalVersionID]

    const result = await window.api.getVersionMetadata(
      { appId: app.id || undefined, bundleID: app.bundleID || undefined },
      externalVersionID,
      platform || undefined
    )

    if (!result.ok) return null

    const metadata = result.data
    set((state) => ({ meta: { ...state.meta, [externalVersionID]: metadata } }))

    diskCache[cacheKeyFor(app.id, app.bundleID, platform)] = metadata
    saveCache()
    return metadata
  },

  async resolveAll() {
    const { ids, meta, resolving } = get()
    if (resolving) return

    const pending = ids.filter((id) => !meta[id])
    if (pending.length === 0) return

    set({ resolving: true, resolvedCount: ids.length - pending.length, totalToResolve: ids.length })

    // Bounded concurrency: enough to feel quick, small enough to avoid tripping
    // Apple's rate limiting on apps with a long release history.
    let cursor = 0
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = cursor
        cursor += 1
        if (index >= pending.length) return
        // Bail out if the drawer was closed or switched to another app.
        if (!get().resolving) return
        await get().resolveOne(pending[index])
        set((state) => ({ resolvedCount: state.resolvedCount + 1 }))
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(RESOLVE_CONCURRENCY, pending.length) }, () => worker())
    )

    set({ resolving: false })
  },

  close() {
    set({
      app: null,
      ids: [],
      meta: {},
      loading: false,
      resolving: false,
      resolvedCount: 0,
      totalToResolve: 0,
      error: null
    })
  }
}))
