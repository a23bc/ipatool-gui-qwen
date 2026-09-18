/**
 * Search state.
 *
 * Results are cached per (account, term, platform, limit) so paging back through
 * the UI is instant and a repeated query does not hit Apple again. The cache is
 * bounded and lives only in memory - it is a convenience, not a source of truth.
 *
 * The **account is part of the key**, because the storefront comes from the
 * signed-in account: the same term legitimately returns different catalogues for
 * two Apple IDs, and a cache that ignored the account would show account A's
 * results as if they were account B's. Switching accounts also drops what is on
 * screen and invalidates any search still in flight, so a late response can never
 * repopulate the list with the previous session's data.
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
  /** Account the displayed results were fetched for. */
  accountId: string
  /** Bumped on every account change, so in-flight searches can be discarded. */
  epoch: number

  setTerm: (term: string) => void
  setPlatform: (platform: Platform) => void
  setLimit: (limit: number) => void
  run: (term?: string) => Promise<void>
  clearResults: () => void
  clearHistory: () => void
  removeHistory: (term: string) => void
}

function cacheKey(accountId: string, term: string, platform: Platform, limit: number): string {
  return `${accountId}|${term.trim().toLowerCase()}|${platform}|${limit}`
}

/** The account every request will actually run as, straight from the live store. */
function currentAccountId(): string {
  return useAppStore.getState().accounts.activeId
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
  accountId: currentAccountId(),
  epoch: 0,

  setTerm: (term) => set({ term }),
  setPlatform: (platform) => set({ platform }),
  setLimit: (limit) => set({ limit }),

  async run(term) {
    const query = (term ?? get().term).trim()
    if (query === '') return

    const { platform, limit } = get()
    const accountId = currentAccountId()
    const epoch = get().epoch
    const key = cacheKey(accountId, query, platform, limit)
    const cached = readCache(key)
    if (cached) {
      set({ results: cached.apps, query, error: null, loading: false, accountId })
      return
    }

    set({ loading: true, error: null, query, accountId })

    let result
    try {
      result = await window.api.search({ term: query, limit, platform })
    } catch (error) {
      // IPC itself rejected (main crashed / bridge gone). Without this the
      // store would spin forever: loading stays true and nothing can retry.
      if (get().epoch !== epoch) return
      set({
        loading: false,
        results: [],
        error: { message: String(error), hint: null, code: null }
      })
      return
    }

    // The account (or the whole session) changed while this was in flight: the
    // answer belongs to the previous one, so it is dropped rather than shown.
    if (get().epoch !== epoch || currentAccountId() !== accountId) return

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

/**
 * Drops the displayed results whenever a different account becomes active.
 *
 * Only the results (and any error) are cleared, not the term: the user asked for
 * that search under the old account, and re-running it under the new one is one
 * keypress away - whereas silently keeping the list is what made a switch look
 * like it had not happened. The cached entries are left alone, since they are
 * keyed by account and are correct again on switching back.
 */
export function initSearchSession(): () => void {
  const off = window.api.on('accounts:changed', (snapshot) => {
    const next = snapshot.activeId
    if (useSearchStore.getState().accountId === next) return
    useSearchStore.setState((state) => ({
      accountId: next,
      epoch: state.epoch + 1,
      results: [],
      query: '',
      error: null,
      loading: false
    }))
  })

  // The first snapshot may already have arrived (init() fetches it before React
  // mounts this view), so seed from what the app store knows.
  const active = currentAccountId()
  if (active !== '' && useSearchStore.getState().accountId !== active) {
    useSearchStore.setState({ accountId: active })
  }

  return off
}
