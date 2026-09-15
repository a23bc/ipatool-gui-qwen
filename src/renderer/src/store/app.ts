/**
 * Application-level state: app metadata, settings, engine status, account.
 *
 * Also owns theme and locale resolution, because both depend on a setting plus
 * an OS signal and both are applied as side effects (a `data-theme` attribute
 * write and a translator swap) rather than as rendered values.
 */

import { create } from 'zustand'
import type { AccountInfo, AppInfoPayload, EngineStatus, Settings, ThemeMode } from '@shared/types'
import { createTranslator, detectLocale, type Locale, type Translator } from '@renderer/i18n'
import { useUiStore } from './ui'

const IDLE_ENGINE: EngineStatus = {
  state: 'idle',
  path: null,
  version: null,
  source: null,
  message: null,
  code: null,
  download: null
}

export interface AppState {
  appInfo: AppInfoPayload | null
  settings: Settings
  engine: EngineStatus
  account: AccountInfo | null
  accountChecked: boolean
  systemTheme: 'light' | 'dark'
  locale: Locale
  t: Translator
  ready: boolean

  init: () => Promise<void>
  updateSettings: (patch: Partial<Settings>) => Promise<void>
  resetSettings: () => Promise<void>
  detectEngine: (force?: boolean) => Promise<EngineStatus>
  installEngine: (version?: string) => Promise<EngineStatus>
  uninstallEngine: () => Promise<EngineStatus>
  refreshAccount: () => Promise<AccountInfo | null>
  revokeAccount: () => Promise<boolean>
  setAccount: (account: AccountInfo | null) => void
}

function resolveLocale(mode: Settings['locale'], systemLocale: string): Locale {
  if (mode === 'zh-CN' || mode === 'en-US') return mode
  return detectLocale(systemLocale)
}

function resolveTheme(mode: ThemeMode, systemTheme: 'light' | 'dark'): 'light' | 'dark' {
  return mode === 'system' ? systemTheme : mode
}

function applyTheme(theme: 'light' | 'dark'): void {
  document.documentElement.dataset.theme = theme
  const meta = document.querySelector('meta[name="color-scheme"]')
  if (meta) meta.setAttribute('content', theme === 'dark' ? 'dark light' : 'light dark')
}

let initialised = false
let disposers: Array<() => void> = []

/**
 * Unsubscribes every IPC listener installed by init() and allows a fresh
 * init(). Production code never calls this (the module-level guard makes init
 * idempotent); it exists for HMR teardown and unit tests, which otherwise
 * leave listeners dangling on window.api across module reloads/imports.
 */
export function disposeAppStore(): void {
  for (const dispose of disposers) dispose()
  disposers = []
  initialised = false
}

export const useAppStore = create<AppState>()((set, get) => ({
  appInfo: null,
  settings: {
    // Sensible placeholders until the real settings arrive; keeps the first
    // render from having to null-check every field.
    ipatoolPath: '',
    autoInstallEngine: true,
    engineVersion: '',
    githubMirror: '',
    downloadDir: '',
    concurrency: 2,
    autoPurchase: true,
    defaultPlatform: '',
    searchLimit: 25,
    purchasesPageSize: 50,
    passphraseMode: 'auto',
    keychainPassphrase: '',
    profiles: [],
    activeProfileId: '',
    profileCounter: 1,
    verbose: false,
    theme: 'system',
    locale: 'system',
    artworkEnabled: true,
    artworkCountry: 'us',
    maxLogLines: 2000,
    resumeQueueOnLaunch: true,
    notifyOnComplete: true,
    confirmCloseWhileDownloading: true,
    lastEmail: ''
  },
  engine: IDLE_ENGINE,
  account: null,
  accountChecked: false,
  systemTheme: 'dark',
  locale: 'en-US',
  t: createTranslator('en-US'),
  ready: false,

  async init() {
    if (initialised) return
    initialised = true

    const api = window.api
    const [appInfo, settings, engine, account] = await Promise.all([
      api.getAppInfo(),
      api.getSettings(),
      api.getEngineStatus(),
      api.getAccount()
    ])

    const systemTheme: 'light' | 'dark' =
      typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: light)').matches
        ? 'light'
        : 'dark'

    const locale = resolveLocale(settings.locale, appInfo.locale)
    applyTheme(resolveTheme(settings.theme, systemTheme))

    set({
      appInfo,
      settings,
      engine,
      account,
      accountChecked: account !== null,
      systemTheme,
      locale,
      t: createTranslator(locale),
      ready: true
    })

    // --- event subscriptions -------------------------------------------
    // Every unsubscribe is collected so disposeAppStore() can fully detach
    // this store from the bridge (HMR / tests).
    disposers.push(api.on('engine:status', (next) => set({ engine: next })))
    disposers.push(api.on('engine:progress', (next) => set({ engine: next })))

    disposers.push(api.on('account:changed', (next) => set({ account: next, accountChecked: true })))

    disposers.push(
      api.on('system:theme', (next) => {
        set({ systemTheme: next })
        applyTheme(resolveTheme(get().settings.theme, next))
      })
    )

    disposers.push(
      api.on('settings:changed', (next) => {
        const locale = resolveLocale(next.locale, get().appInfo?.locale ?? '')
        applyTheme(resolveTheme(next.theme, get().systemTheme))
        set((state) => ({
          settings: next,
          locale,
          t: locale === state.locale ? state.t : createTranslator(locale)
        }))
      })
    )

    // The main process resolves/downloads the engine after first paint; make
    // sure we show its latest state even if the events raced the subscription.
    void api.detectEngine(false).then((latest) => set({ engine: latest }))
  },

  async updateSettings(patch) {
    const settings = await window.api.updateSettings(patch)
    const locale = resolveLocale(settings.locale, get().appInfo?.locale ?? '')
    applyTheme(resolveTheme(settings.theme, get().systemTheme))
    set((state) => ({
      settings,
      locale,
      t: locale === state.locale ? state.t : createTranslator(locale)
    }))
  },

  async resetSettings() {
    const settings = await window.api.resetSettings()
    const locale = resolveLocale(settings.locale, get().appInfo?.locale ?? '')
    applyTheme(resolveTheme(settings.theme, get().systemTheme))
    set((state) => ({
      settings,
      locale,
      t: locale === state.locale ? state.t : createTranslator(locale)
    }))
  },

  async detectEngine(force) {
    const engine = await window.api.detectEngine(force)
    set({ engine })
    return engine
  },

  async installEngine(version) {
    const engine = await window.api.installEngine(version)
    set({ engine })
    return engine
  },

  async uninstallEngine() {
    const engine = await window.api.uninstallEngine()
    set({ engine })
    return engine
  },

  async refreshAccount() {
    const account = await window.api.refreshAccount()
    set({ account, accountChecked: true })
    return account
  },

  async revokeAccount() {
    const result = await window.api.revoke()
    if (result.ok) {
      set({ account: null })
      useUiStore.getState().toast({ kind: 'success', message: get().t('toast.signedOut') })
      return true
    }
    useUiStore.getState().toast({ kind: 'error', message: result.error })
    return false
  },

  setAccount(account) {
    set({ account, accountChecked: true })
  }
}))

/** True when the engine can actually run commands. */
export function engineReady(engine: EngineStatus): boolean {
  return engine.state === 'ready' && Boolean(engine.path)
}
