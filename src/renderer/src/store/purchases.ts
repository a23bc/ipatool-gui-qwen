/**
 * Purchases (apps owned by the signed-in Apple ID).
 *
 * ipatool pages this list, so the store accumulates pages and lets the user keep
 * loading. Selection is keyed on `id|bundleID` rather than the array index, so it
 * survives filtering and paging.
 */

import { create } from 'zustand'
import type { Platform, StoreApp } from '@shared/types'
import { useAppStore } from './app'
import { useUiStore } from './ui'

export interface PurchasesState {
  apps: StoreApp[]
  /** Pages already loaded, in order. */
  loadedPages: number[]
  page: number
  totalCount: number
  platform: Platform
  filter: string
  selection: string[]
  loading: boolean
  loaded: boolean
  error: { message: string; hint: string | null; code: string | null } | null

  setPlatform: (platform: Platform) => void
  setFilter: (filter: string) => void
  load: (page?: number, append?: boolean) => Promise<void>
  loadMore: () => Promise<void>
  toggle: (key: string) => void
  selectKeys: (keys: string[]) => void
  clearSelection: () => void
  reset: () => void
}

export function appKey(app: StoreApp): string {
  return `${app.id}|${app.bundleID}`
}

export function visibleApps(apps: StoreApp[], filter: string): StoreApp[] {
  const needle = filter.trim().toLowerCase()
  if (!needle) return apps
  return apps.filter(
    (app) =>
      app.name.toLowerCase().includes(needle) ||
      app.bundleID.toLowerCase().includes(needle) ||
      String(app.id).includes(needle)
  )
}

export const usePurchasesStore = create<PurchasesState>()((set, get) => ({
  apps: [],
  loadedPages: [],
  page: 1,
  totalCount: 0,
  platform: '',
  filter: '',
  selection: [],
  loading: false,
  loaded: false,
  error: null,

  setPlatform: (platform) => {
    set({ platform })
    if (get().loaded) void get().load(1, false)
  },

  setFilter: (filter) => set({ filter }),

  async load(page = 1, append = false) {
    const settings = useAppStore.getState().settings
    set({ loading: true, error: null })

    let result
    try {
      result = await window.api.listPurchases({
        page,
        maxResults: settings.purchasesPageSize,
        platform: get().platform || undefined
      })
    } catch (error) {
      // Same contract as search.run: an IPC rejection must roll the loading
      // state back instead of leaving the view spinning forever.
      set({ loading: false, error: { message: String(error), hint: null, code: null } })
      return
    }

    if (!result.ok) {
      set({
        loading: false,
        error: { message: result.error, hint: result.hint, code: result.code }
      })
      if (result.code === 'not-signed-in') useUiStore.getState().setAuthOpen(true)
      return
    }

    const incoming = result.data.apps
    const existing = append ? get().apps : []
    // De-duplicate across pages: Apple can repeat an app when the catalogue
    // shifts between requests.
    const seen = new Set(existing.map(appKey))
    const merged = existing.concat(incoming.filter((app) => !seen.has(appKey(app))))

    set({
      apps: merged,
      page,
      totalCount: result.data.totalCount,
      loadedPages: append ? Array.from(new Set([...get().loadedPages, page])) : [page],
      loading: false,
      loaded: true,
      error: null
    })
  },

  async loadMore() {
    const { page, totalCount, apps, loading } = get()
    if (loading) return
    if (totalCount > 0 && apps.length >= totalCount) return
    await get().load(page + 1, true)
  },

  toggle(key) {
    const selection = get().selection
    set({
      selection: selection.includes(key) ? selection.filter((k) => k !== key) : selection.concat(key)
    })
  },

  selectKeys(keys) {
    set({ selection: Array.from(new Set(keys)) })
  },

  clearSelection() {
    set({ selection: [] })
  },

  reset() {
    set({
      apps: [],
      loadedPages: [],
      page: 1,
      totalCount: 0,
      // The previous account's storefront/platform choice must not leak into
      // the next one: reset() runs on profile switch, and querying the new
      // session with the old platform can legitimately return zero results.
      platform: useAppStore.getState().settings.defaultPlatform,
      filter: '',
      selection: [],
      loading: false,
      loaded: false,
      error: null
    })
  }
}))
