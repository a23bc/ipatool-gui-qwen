import { memo, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { Platform } from '@shared/types'
import { useAppStore, engineReady } from '@renderer/store/app'
import { useQueueStore } from '@renderer/store/queue'
import { useProfilesStore } from '@renderer/store/profiles'
import { useSearchStore } from '@renderer/store/search'
import { useUiStore } from '@renderer/store/ui'
import { Icon, Spinner } from './Icon'
import { PlatformSelect } from './Badges'

/** Reserved space for OS window controls, per platform. */
function useChromePadding(): { left: number; right: number } {
  const platform = useAppStore((state) => state.appInfo?.platform)
  if (platform === 'darwin') return { left: 78, right: 12 }
  if (platform === 'win32') return { left: 12, right: 148 }
  return { left: 12, right: 12 }
}

function EnginePill(): ReactNode {
  const engine = useAppStore((state) => state.engine)
  const t = useAppStore((state) => state.t)
  const setView = useUiStore((state) => state.setView)

  let label: string
  let tone: 'ok' | 'warn' | 'bad'

  if (engineReady(engine)) {
    label = t('engine.pill.ready', { version: engine.version ?? '' })
    tone = 'ok'
  } else if (engine.state === 'downloading') {
    const percent = engine.download?.percent
    label = t('engine.pill.downloading', { percent: percent == null ? '…' : Math.round(percent) })
    tone = 'warn'
  } else if (engine.state === 'checking' || engine.state === 'idle') {
    label = t('engine.pill.checking')
    tone = 'warn'
  } else if (engine.state === 'missing') {
    label = t('engine.pill.missing')
    tone = 'bad'
  } else {
    label = t('engine.pill.error')
    tone = 'bad'
  }

  const colors = {
    ok: { fg: 'var(--success)', bg: 'var(--success-soft)' },
    warn: { fg: 'var(--warn)', bg: 'var(--warn-soft)' },
    bad: { fg: 'var(--danger)', bg: 'var(--danger-soft)' }
  }[tone]

  return (
    <button
      type="button"
      onClick={() => setView('settings')}
      className="no-drag flex h-[26px] shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[11.5px] font-semibold transition-transform active:scale-[0.97]"
      style={{ background: colors.bg, color: colors.fg }}
      title={engine.path ?? engine.message ?? label}
    >
      {engine.state === 'downloading' || engine.state === 'checking' ? (
        <Spinner size={11} />
      ) : (
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: colors.fg }} />
      )}
      <span className="max-w-[150px] truncate">{label}</span>
    </button>
  )
}

function AccountButton(): ReactNode {
  const account = useAppStore((state) => state.account)
  const t = useAppStore((state) => state.t)
  const setAccountsOpen = useUiStore((state) => state.setAccountsOpen)
  const setAuthOpen = useUiStore((state) => state.setAuthOpen)

  const profiles = useProfilesStore((state) => state.profiles)
  const loaded = useProfilesStore((state) => state.loaded)
  const load = useProfilesStore((state) => state.load)
  const setActive = useProfilesStore((state) => state.setActive)
  const busy = useProfilesStore((state) => state.busy)

  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!loaded) void load()
  }, [loaded, load])

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={rootRef} className="no-drag relative">
      <button
        type="button"
        className="btn btn-ghost h-[26px] gap-1.5 px-2"
        onClick={() => setOpen((value) => !value)}
        title={account ? account.name || account.email : t('auth.signIn')}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Icon name="user" size={13} />
        <span className="max-w-[150px] truncate text-[11.5px]">
          {account ? account.email : t('auth.signedOut')}
        </span>
        <Icon name="chevronDown" size={11} />
      </button>

      {open ? (
        <div
          role="menu"
          className="panel fade-in absolute right-0 top-[30px] z-50 flex w-[264px] flex-col py-1"
          style={{ boxShadow: 'var(--shadow)' }}
        >
          {profiles.map((profile) => (
            <button
              key={profile.id}
              type="button"
              role="menuitem"
              disabled={busy !== null}
              className="flex items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-[var(--row-hover)]"
              onClick={() => {
                setOpen(false)
                if (!profile.active) void setActive(profile.id)
              }}
            >
              <span style={{ color: profile.active ? 'var(--accent)' : 'var(--text-faint)' }}>
                <Icon name={profile.active ? 'checkCircle' : 'user'} size={13} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] font-medium">{profile.name}</span>
                <span className="mono block truncate text-[10.5px] faint">
                  {profile.remark
                    ? `${profile.email || t('accounts.notSignedIn')} · ${profile.remark}`
                    : profile.email || t('accounts.notSignedIn')}
                </span>
              </span>
              {busy === profile.id ? <Spinner size={12} /> : null}
            </button>
          ))}

          <div className="divider my-1" />

          <button
            type="button"
            role="menuitem"
            className="flex items-center gap-2 px-3 py-1.5 text-left text-[12px] transition-colors hover:bg-[var(--row-hover)]"
            onClick={() => {
              setOpen(false)
              setAuthOpen(true)
            }}
          >
            <Icon name="key" size={13} />
            {account ? t('accounts.relogin') : t('auth.signIn')}
          </button>
          <button
            type="button"
            role="menuitem"
            className="flex items-center gap-2 px-3 py-1.5 text-left text-[12px] transition-colors hover:bg-[var(--row-hover)]"
            onClick={() => {
              setOpen(false)
              setAccountsOpen(true)
            }}
          >
            <Icon name="settings" size={13} />
            {t('accounts.title')}
          </button>
        </div>
      ) : null}
    </div>
  )
}

export const Header = memo(function Header(): ReactNode {
  const t = useAppStore((state) => state.t)
  const settings = useAppStore((state) => state.settings)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const systemTheme = useAppStore((state) => state.systemTheme)

  const term = useSearchStore((state) => state.term)
  const setTerm = useSearchStore((state) => state.setTerm)
  const run = useSearchStore((state) => state.run)
  const loading = useSearchStore((state) => state.loading)

  const platform = useSearchStore((state) => state.platform)
  const setPlatform = useSearchStore((state) => state.setPlatform)

  const setView = useUiStore((state) => state.setView)
  const setPaletteOpen = useUiStore((state) => state.setPaletteOpen)

  const inputRef = useRef<HTMLInputElement>(null)
  const padding = useChromePadding()

  // The search store owns `platform`, but Settings owns the default; keep them in
  // sync so changing the default applies to the next search.
  useEffect(() => {
    setPlatform(settings.defaultPlatform)
  }, [settings.defaultPlatform, setPlatform])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // "/" focuses search unless the user is already typing somewhere.
      const target = event.target as HTMLElement | null
      const typing =
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      if (event.key === '/' && !typing) {
        event.preventDefault()
        setView('search')
        inputRef.current?.focus()
        inputRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setView])

  const dark = settings.theme === 'system' ? systemTheme === 'dark' : settings.theme === 'dark'

  return (
    <header
      className="drag flex h-[var(--header-h)] shrink-0 items-center gap-2 border-b"
      style={{
        borderColor: 'var(--border)',
        background: 'var(--bg-elev)',
        paddingLeft: padding.left,
        paddingRight: padding.right
      }}
    >
      <div className="relative flex h-[28px] min-w-0 flex-1 items-center">
        <span className="pointer-events-none absolute left-2.5 flex" style={{ color: 'var(--text-faint)' }}>
          {loading ? <Spinner size={13} /> : <Icon name="search" size={13} />}
        </span>
        <input
          ref={inputRef}
          className="input no-drag h-[28px] pl-8 pr-3"
          type="search"
          value={term}
          placeholder={t('search.placeholder')}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => setTerm(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void run()
            }
            if (event.key === 'Escape') {
              event.currentTarget.blur()
            }
          }}
        />
      </div>

      <PlatformSelect
        value={platform as Platform}
        onChange={(next) => {
          setPlatform(next)
          if (term.trim() !== '') void run()
        }}
        className="no-drag h-[28px] max-w-[170px]"
      />

      <span className="mx-0.5 h-4 w-px shrink-0" style={{ background: 'var(--border)' }} />

      <EnginePill />
      <AccountButton />

      <button
        type="button"
        className="no-drag btn btn-ghost btn-icon h-[26px] w-[26px]"
        onClick={() => setPaletteOpen(true)}
        title={`${t('palette.placeholder')}  (Ctrl/⌘ K)`}
      >
        <Icon name="command" size={13} />
      </button>

      <button
        type="button"
        className="no-drag btn btn-ghost btn-icon h-[26px] w-[26px]"
        onClick={() => void updateSettings({ theme: dark ? 'light' : 'dark' })}
        title={t('palette.act.toggleTheme')}
      >
        <Icon name={dark ? 'sun' : 'moon'} size={13} />
      </button>
    </header>
  )
})

/** Bottom strip: engine path, account, queue totals and shortcut hints. */
export const StatusBar = memo(function StatusBar(): ReactNode {
  const t = useAppStore((state) => state.t)
  const engine = useAppStore((state) => state.engine)
  const account = useAppStore((state) => state.account)
  const appInfo = useAppStore((state) => state.appInfo)
  const stats = useQueueStore((state) => state.stats)
  const setPaletteOpen = useUiStore((state) => state.setPaletteOpen)
  const padding = useChromePadding()

  return (
    <footer
      className="flex h-[var(--statusbar-h)] shrink-0 items-center gap-3 border-t px-3 text-[11px]"
      style={{ borderColor: 'var(--border)', background: 'var(--bg-elev)', color: 'var(--text-faint)', paddingLeft: Math.max(padding.left, 12) }}
    >
      <span className="flex items-center gap-1.5 truncate" title={engine.path ?? undefined}>
        <span
          className="h-1.5 w-1.5 rounded-full"
          style={{
            background: engineReady(engine)
              ? 'var(--success)'
              : engine.state === 'missing'
                ? 'var(--danger)'
                : 'var(--warn)'
          }}
        />
        {t('statusbar.engine')}: {engine.version ?? t(`engine.state.${engine.state}`)}
      </span>

      <span className="truncate">
        {t('statusbar.account')}: {account ? account.email : t('auth.signedOut')}
      </span>

      <span className="truncate">
        {t('statusbar.queue')}: {stats.running > 0 ? t('statusbar.active', { n: stats.running }) : t('statusbar.idle')}
        {stats.queued > 0 ? ` · ${stats.queued} ⏳` : ''}
        {stats.error > 0 ? ` · ${stats.error} ✕` : ''}
      </span>

      <button
        type="button"
        className="no-drag ml-auto flex items-center gap-1.5 rounded px-1 py-0.5 transition-colors hover:bg-[var(--row-hover)]"
        onClick={() => setPaletteOpen(true)}
      >
        <span className="kbd">Ctrl</span>
        <span className="kbd">K</span>
      </button>

      {appInfo ? <span className="shrink-0 tabular-nums">v{appInfo.appVersion}</span> : null}
    </footer>
  )
})
