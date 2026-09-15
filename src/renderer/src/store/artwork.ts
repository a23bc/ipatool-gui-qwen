/**
 * Artwork store.
 *
 * Icons are fetched lazily by whichever row is actually on screen, deduplicated
 * in flight, and cached in the main process (memory + disk). Keeping this in its
 * own store means an icon arriving does not invalidate the search-results store
 * and re-render the whole list.
 */

import { create } from 'zustand'
import { useAppStore } from './app'

export interface ArtworkState {
  byId: Record<number, string | null>
  request: (appId: number) => void
  invalidate: (appId: number) => void
  /** Drops every cached icon; mirrors `window.api.clearArtworkCache()`. */
  invalidateAll: () => void
}

const inflight = new Set<number>()

export const useArtworkStore = create<ArtworkState>()((set, get) => ({
  byId: {},

  request(appId) {
    if (!Number.isFinite(appId) || appId <= 0) return
    if (!useAppStore.getState().settings.artworkEnabled) return
    if (appId in get().byId) return
    if (inflight.has(appId)) return

    inflight.add(appId)
    window.api
      .getArtwork(appId)
      .then((dataUrl) => {
        set((state) => ({ byId: { ...state.byId, [appId]: dataUrl } }))
      })
      .catch(() => {
        set((state) => ({ byId: { ...state.byId, [appId]: null } }))
      })
      .finally(() => {
        inflight.delete(appId)
      })
  },

  invalidate(appId) {
    inflight.delete(appId)
    set((state) => {
      const next = { ...state.byId }
      delete next[appId]
      return { byId: next }
    })
  },

  invalidateAll() {
    inflight.clear()
    set({ byId: {} })
  }
}))

/** Convenience selector for a single icon. */
export function selectArtwork(appId: number): string | null | undefined {
  return useArtworkStore.getState().byId[appId]
}
