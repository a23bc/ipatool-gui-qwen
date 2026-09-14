/**
 * Search state.
 *
 * Results are cached per (term, platform, limit) so paging back through the UI
 * is instant and a repeated query does not hit Apple again. The cache is bounded
 * and lives only in memory - it is a convenience, not a source of truth.
 */

import { create } from 'zustand'
import type { Platform, StoreApp } from '@shared/types'
import { readJson, writeJson } from '@renderer/lib/storage'
import { useAppStore } from './app'
import { useUiStore } from './ui'

const HISTORY_KEY = 'search.history'
const HISTORY_LIMIT = 12
const CACHE_LIMIT = 24

export interface SearchError {
  message: string
  hint: string | null
  code: string | null
}

interface CacheEntry {
  key: string
  at: number
  count: number
  apps: StoreApp[]
}

export interface SearchState {
  term: string
  platform: Platform
  limit: number
  results: StoreApp[]
  /** The term the current results belong to. */
  query: string
  loading: boolean
  error: SearchError | null
  history: string[]

  setTerm: (term: string) => void
  setPlatform: (platform: Platform) => void
  setLimit: (limit: number) => void
  run: (term?: string) => Promise<void>
  clearResults: () => void
  clearHistory: () => void
  removeHistory: (term: string) => void
}

function cacheKey(term: string, platform: Platform, limit: number): string {
  return `${term.trim().toLowerCase()}|${platform}|${limit}`
}

let cache: CacheEntry[] = []

function readCache(key: string): CacheEntry | undefined {
  const entry = cache.find((item) => item.key === key)
  if (!entry) return undefined
  // Move to the end so `cache` stays in LRU order.
  cache = cache.filter((item) => item !== entry).concat(entry)
  return entry
}

function writeCache(entry: CacheEntry): void {
  cache = cache.filter((item) => item.key !== entry.key).concat(entry)
  if (cache.length > CACHE_LIMIT) cache = cache.slice(cache.length - CACHE_LIMIT)
}

export const useSearchStore = create<SearchState>()((set, get) => ({
  term: '',
  platform: useAppStore.getState().settings.defaultPlatform,
  limit: useAppStore.getState().settings.searchLimit,
  results: [],
  query: '',
  loading: false,
  error: null,
  history: readJson<string[]>(HISTORY_KEY, []),

  setTerm: (term) => set({ term }),
  setPlatform: (platform) => set({ platform }),
  setLimit: (limit) => set({ limit }),

  async run(term) {
    const query = (term ?? get().term).trim()
    if (query === '') return

    const { platform, limit } = get()
    const key = cacheKey(query, platform, limit)
    const cached = readCache(key)
    if (cached) {
      set({ results: cached.apps, query, error: null, loading: false })
      return
    }

    set({ loading: true, error: null, query })

    const result = await window.api.search({ term: query, limit, platform })

    if (!result.ok) {
      set({
        loading: false,
        results: [],
        error: { message: result.error, hint: result.hint, code: result.code }
      })
      // Not signed in is the single most common failure; point at the fix.
      if (result.code === 'not-signed-in' || result.code === 'passphrase-required') {
        useUiStore.getState().setAuthOpen(true)
      }
      return
    }

    writeCache({ key, at: Date.now(), count: result.data.count, apps: result.data.apps })

    const history = [query, ...get().history.filter((item) => item !== query)].slice(0, HISTORY_LIMIT)
    writeJson(HISTORY_KEY, history)

    set({ loading: false, results: result.data.apps, error: null, history })
  },

  clearResults() {
    set({ results: [], query: '', error: null })
  },

  clearHistory() {
    writeJson(HISTORY_KEY, [])
    set({ history: [] })
  },

  removeHistory(term) {
    const history = get().history.filter((item) => item !== term)
    writeJson(HISTORY_KEY, history)
    set({ history })
  }
}))
