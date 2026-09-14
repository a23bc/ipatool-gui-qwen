/**
 * UI state: active view, command palette, modals, toasts and the confirm dialog.
 *
 * Deliberately free of any import from the app store - `app.ts` depends on this
 * module for toasts, so a reverse dependency would be a cycle.
 */

import { create } from 'zustand'
import type { StoreApp } from '@shared/types'

export type View = 'search' | 'purchases' | 'downloads' | 'activity' | 'console' | 'settings'

export const VIEWS: View[] = ['search', 'purchases', 'downloads', 'activity', 'console', 'settings']

export type ToastKind = 'info' | 'success' | 'warn' | 'error'

export interface ToastInput {
  kind?: ToastKind
  message: string
  detail?: string
  actionLabel?: string
  onAction?: () => void
  /** Milliseconds; 0 keeps it until dismissed. */
  duration?: number
}

export interface Toast extends Required<Pick<ToastInput, 'kind' | 'message' | 'duration'>> {
  id: number
  detail?: string
  actionLabel?: string
  onAction?: () => void
}

export interface ConfirmRequest {
  title: string
  body?: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
}

interface ConfirmState extends ConfirmRequest {
  resolve: (ok: boolean) => void
}

export interface UiState {
  view: View
  setView: (view: View) => void

  paletteOpen: boolean
  setPaletteOpen: (open: boolean) => void

  authOpen: boolean
  setAuthOpen: (open: boolean) => void

  /** App whose version history drawer is open, if any. */
  versionsFor: StoreApp | null
  setVersionsFor: (app: StoreApp | null) => void

  confirm: ConfirmState | null
  askConfirm: (request: ConfirmRequest) => Promise<boolean>
  resolveConfirm: (ok: boolean) => void

  toasts: Toast[]
  toast: (input: ToastInput) => number
  dismissToast: (id: number) => void

  /** True while a first-run blocking overlay is shown. */
  setupDismissed: boolean
  dismissSetup: () => void
}

let toastId = 0
const timers = new Map<number, ReturnType<typeof setTimeout>>()

export const useUiStore = create<UiState>()((set, get) => ({
  view: 'search',
  setView: (view) => set({ view, paletteOpen: false }),

  paletteOpen: false,
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),

  authOpen: false,
  setAuthOpen: (authOpen) => set({ authOpen }),

  versionsFor: null,
  setVersionsFor: (versionsFor) => set({ versionsFor }),

  confirm: null,
  askConfirm: (request) =>
    new Promise<boolean>((resolve) => {
      set({ confirm: { ...request, resolve } })
    }),
  resolveConfirm: (ok) => {
    const current = get().confirm
    set({ confirm: null })
    current?.resolve(ok)
  },

  toasts: [],
  toast: (input) => {
    const id = (toastId += 1)
    const toast: Toast = {
      id,
      kind: input.kind ?? 'info',
      message: input.message,
      duration: input.duration ?? 4200,
      ...(input.detail !== undefined ? { detail: input.detail } : {}),
      ...(input.actionLabel !== undefined ? { actionLabel: input.actionLabel } : {}),
      ...(input.onAction !== undefined ? { onAction: input.onAction } : {})
    }
    // Cap the stack so a burst of failures cannot cover the UI.
    set((state) => ({ toasts: [...state.toasts.slice(-4), toast] }))

    if (toast.duration > 0) {
      const timer = setTimeout(() => get().dismissToast(id), toast.duration)
      timers.set(id, timer)
    }
    return id
  },
  dismissToast: (id) => {
    const timer = timers.get(id)
    if (timer) {
      clearTimeout(timer)
      timers.delete(id)
    }
    set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }))
  },

  setupDismissed: false,
  dismissSetup: () => set({ setupDismissed: true })
}))
