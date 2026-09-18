/**
 * Application-level state: app metadata, settings, engine status, account.
 *
 * Also owns theme and locale resolution, because both depend on a setting plus
 * an OS signal and both are applied as side effects (a `data-theme` attribute
 * write and a translator swap) rather than as rendered values.
 */

import { create } from 'zustand'
import type {
  AccountInfo,
  AccountsSnapshot,
  AppInfoPayload,
  EngineStatus,
  Settings,
  ThemeMode
} from '@shared/types'
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

/** Placeholder until the main process reports the real capability. */
const EMPTY_ACCOUNTS: AccountsSnapshot = {
  accounts: [],
  activeId: '',
  credentialSlot: 'file',
  slotBridge: 'not-needed',
  slotDetail: '',
  legacy: null
}

export interface AppState {
  appInfo: AppInfoPayload | null
  settings: Settings
  engine: EngineStatus
  /** Every registered account, plus the platform's credential-slot capability. */
  accounts: AccountsSnapshot
  /** Identity of the *active* account, or null when it has no usable session. */
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
  refreshAccount: (accountId?: string) => Promise<AccountInfo | null>
  revokeAccount: (accountId?: string) => Promise<boolean>
  setAccount: (account: AccountInfo | null) => void

  getAccounts: () => Promise<AccountsSnapshot>
  addAccount: (remark?: string) => Promise<string | null>
  activateAccount: (id: string) => Promise<AccountSwitchResult>
  updateAccount: (id: string, remark: string) => Promise<void>
  removeAccount: (id: string) => Promise<boolean>
  verifyAccount: (id: string) => Promise<AccountSwitchResult>
}

/** What a switch/verify attempt reported, flattened for the UI. */
export interface AccountSwitchResult {
  ok: boolean
  status: string
  message: string
}

/**
 * Projects the account snapshot onto the active identity.
 *
 * Derived rather than stored separately: `account` is what every screen gates on
 * ("are we signed in?"), and letting it drift from the snapshot is how a UI ends
 * up believing it is signed in as A while the main process runs as B.
 */
function activeIdentity(snapshot: AccountsSnapshot): AccountInfo | null {
  const active = snapshot.accounts.find((entry) => entry.id === snapshot.activeId)
  if (!active || !active.signedIn) return null
  return { name: active.name, email: active.email }
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
    isolateSessionHome: true,
    accounts: [],
    activeAccountId: '',
    accountCounter: 1,
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
  accounts: EMPTY_ACCOUNTS,
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
    const [appInfo, settings, engine, accounts] = await Promise.all([
      api.getAppInfo(),
      api.getSettings(),
      api.getEngineStatus(),
      api.getAccounts()
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
      accounts,
      account: activeIdentity(accounts),
      accountChecked: true,
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

    // The account list is the single source of truth for "who are we signed in
    // as": the active pointer, every session's state and the platform's
    // credential-slot capability all arrive together.
    disposers.push(
      api.on('accounts:changed', (next) => set({ accounts: next, account: activeIdentity(next), accountChecked: true }))
    )

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

  async refreshAccount(accountId) {
    const account = await window.api.refreshAccount(accountId)
    set((state) => ({
      account: accountId === undefined ? account : state.account,
      accountChecked: true
    }))
    return account
  },

  async revokeAccount(accountId) {
    const result = await window.api.revoke(accountId)
    if (result.ok) {
      set({ account: accountId === undefined ? null : get().account })
      useUiStore.getState().toast({ kind: 'success', message: get().t('toast.signedOut') })
      return true
    }
    useUiStore.getState().toast({ kind: 'error', message: result.error })
    return false
  },

  setAccount(account) {
    set({ account, accountChecked: true })
  },

  /* ------------------------------------------------------------------ *
   * accounts
   * ------------------------------------------------------------------ */

  async getAccounts() {
    const accounts = await window.api.getAccounts()
    set({ accounts, account: activeIdentity(accounts) })
    return accounts
  },

  /**
   * Creates an empty account and makes it active; returns its id for the
   * sign-in flow, or null when creating it failed.
   *
   * The id - not the account view - because a never-used slot is deliberately
   * filtered out of the snapshot (see AccountRegistry.isUnused). Looking the new
   * account up in `snapshot.accounts` would therefore come back empty, and the
   * caller would skip the sign-in that the account was created for.
   */
  async addAccount(remark) {
    try {
      const accounts = await window.api.addAccount(remark)
      set({ accounts, account: activeIdentity(accounts) })
      return accounts.activeId || null
    } catch (error) {
      useUiStore.getState().toast({ kind: 'error', message: String(error) })
      return null
    }
  },

  async activateAccount(id) {
    try {
      const { snapshot, check } = await window.api.activateAccount(id)
      set({ accounts: snapshot, account: activeIdentity(snapshot), accountChecked: true })
      return { ok: check.status === 'ok', status: check.status, message: check.message }
    } catch (error) {
      // A failed switch may still have moved the active pointer (it is committed
      // before the probe runs), so re-read rather than assuming nothing changed.
      await get().getAccounts().catch(() => undefined)
      return { ok: false, status: 'error', message: error instanceof Error ? error.message : String(error) }
    }
  },

  async updateAccount(id, remark) {
    try {
      const accounts = await window.api.updateAccount(id, { remark })
      set({ accounts, account: activeIdentity(accounts) })
    } catch (error) {
      useUiStore.getState().toast({ kind: 'error', message: String(error) })
    }
  },

  async removeAccount(id) {
    try {
      const { snapshot } = await window.api.removeAccount(id)
      set({ accounts: snapshot, account: activeIdentity(snapshot), accountChecked: true })
      return true
    } catch (error) {
      useUiStore.getState().toast({
        kind: 'error',
        message: error instanceof Error ? error.message : String(error)
      })
      return false
    }
  },

  async verifyAccount(id) {
    try {
      const { snapshot, check } = await window.api.verifyAccount(id)
      set({ accounts: snapshot, account: activeIdentity(snapshot), accountChecked: true })
      return { ok: check.status === 'ok', status: check.status, message: check.message }
    } catch (error) {
      return { ok: false, status: 'error', message: error instanceof Error ? error.message : String(error) }
    }
  }
}))

/** True when the engine can actually run commands. */
export function engineReady(engine: EngineStatus): boolean {
  return engine.state === 'ready' && Boolean(engine.path)
}
