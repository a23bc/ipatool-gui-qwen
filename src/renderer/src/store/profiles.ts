/**
 * Multi-account state.
 *
 * The authoritative list lives in the main process (settings.json); this store
 * mirrors it and exposes the switcher's actions. Switching is cheap and never
 * logs anyone out - it only changes which state directory future ipatool calls
 * use (see main/profiles.ts).
 */

import { create } from 'zustand'
import type { AccountInfo } from '@shared/types'
import type { ProfileView } from '@shared/ipc'
import { useAppStore } from './app'
import { useUiStore } from './ui'

export interface ProfilesState {
  profiles: ProfileView[]
  loaded: boolean
  busy: string | null

  load: () => Promise<void>
  add: (name: string) => Promise<void>
  rename: (id: string, name: string) => Promise<void>
  setStateDir: (id: string, dir: string) => Promise<void>
  remove: (id: string) => Promise<void>
  setActive: (id: string) => Promise<void>
  refreshInfo: (id: string) => Promise<void>
}

export const useProfilesStore = create<ProfilesState>()((set) => ({
  profiles: [],
  loaded: false,
  busy: null,

  async load() {
    const profiles = await window.api.listProfiles()
    set({ profiles, loaded: true })
  },

  async add(name) {
    set({ busy: 'add' })
    try {
      const profiles = await window.api.addProfile(name)
      set({ profiles })
      // A brand-new profile has no session yet: go straight to login so the
      // flow is one click from "add account" to signed in.
      useUiStore.getState().setAccountsOpen(false)
      useUiStore.getState().setAuthOpen(true)
    } finally {
      set({ busy: null })
    }
  },

  async rename(id, name) {
    const profiles = await window.api.renameProfile(id, name)
    set({ profiles })
  },

  async setStateDir(id, dir) {
    const profiles = await window.api.setProfileStateDir(id, dir)
    set({ profiles })
  },

  async remove(id) {
    set({ busy: id })
    try {
      const result = await window.api.removeProfile(id)
      set({ profiles: result.profiles })
      const { t } = useAppStore.getState()
      useUiStore.getState().toast({
        kind: 'info',
        message: result.removedDir ? t('accounts.removedDir') : t('accounts.keptDir')
      })
      // The active account may have changed underneath us.
      const active = result.profiles.find((profile) => profile.active)
      if (active) {
        const account = await window.api.refreshAccount(active.id).catch(() => null)
        useAppStore.getState().setAccount(account)
      }
    } finally {
      set({ busy: null })
    }
  },

  async setActive(id) {
    set({ busy: id })
    try {
      const result = await window.api.setActiveProfile(id)
      set({ profiles: result.profiles })
      useAppStore.getState().setAccount(result.account)
      // Search results and purchases belong to the previous storefront session.
      const search = await import('./search').then((m) => m.useSearchStore.getState())
      search.clearResults()
      const purchases = await import('./purchases').then((m) => m.usePurchasesStore.getState())
      purchases.reset()
    } finally {
      set({ busy: null })
    }
  },

  async refreshInfo(id) {
    set({ busy: id })
    try {
      const result = await window.api.refreshProfileInfo(id)
      set({ profiles: result.profiles })
      const target = result.profiles.find((profile) => profile.id === id)
      if (target?.active) {
        useAppStore.getState().setAccount(result.account as AccountInfo | null)
      }
    } finally {
      set({ busy: null })
    }
  }
}))

export function activeProfile(profiles: ProfileView[]): ProfileView | null {
  return profiles.find((profile) => profile.active) ?? profiles[0] ?? null
}
