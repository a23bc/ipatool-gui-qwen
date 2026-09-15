import { memo } from 'react'
import type { ReactNode } from 'react'
import { useAppStore, engineReady } from '@renderer/store/app'
import { useQueueStore } from '@renderer/store/queue'
import { useUiStore, type View } from '@renderer/store/ui'
import { Icon, type IconName } from './Icon'

interface NavItem {
  view: View
  icon: IconName
  labelKey: string
  shortcut?: string
}

const LIBRARY: NavItem[] = [
  { view: 'search', icon: 'search', labelKey: 'nav.search', shortcut: '1' },
  { view: 'purchases', icon: 'layers', labelKey: 'nav.purchases', shortcut: '2' },
  { view: 'downloads', icon: 'download', labelKey: 'nav.downloads', shortcut: '3' }
]

const TOOLS: NavItem[] = [
  { view: 'activity', icon: 'activity', labelKey: 'nav.activity', shortcut: '4' },
  { view: 'console', icon: 'terminal', labelKey: 'nav.console', shortcut: '5' },
  { view: 'settings', icon: 'settings', labelKey: 'nav.settings', shortcut: ',' }
]

// n-R2: the button list is static; memo keeps a parent re-render (e.g. engine
// status churn) from re-rendering all six when their own subscriptions are
// unchanged.
const NavButton = memo(function NavButton({ item }: { item: NavItem }): ReactNode {
  const view = useUiStore((state) => state.view)
  const setView = useUiStore((state) => state.setView)
  const t = useAppStore((state) => state.t)
  const badge = useQueueStore((state) =>
    item.view === 'downloads' ? state.stats.running + state.stats.queued : 0
  )
  const active = view === item.view

  return (
    <button
      type="button"
      onClick={() => setView(item.view)}
      className="no-drag group flex w-full items-center gap-2.5 rounded-md px-2.5 py-[7px] text-left text-[12.5px] transition-colors"
      style={{
        background: active ? 'var(--accent-soft)' : 'transparent',
        color: active ? 'var(--accent)' : 'var(--text-dim)',
        fontWeight: active ? 600 : 500
      }}
      title={t(item.labelKey)}
    >
      <Icon name={item.icon} size={15} strokeWidth={active ? 2 : 1.75} />
      <span className="flex-1 truncate">{t(item.labelKey)}</span>
      {badge > 0 ? (
        <span
          className="rounded-full px-1.5 text-[10.5px] font-semibold tabular-nums"
          style={{ background: 'var(--accent)', color: 'var(--accent-text)' }}
        >
          {badge > 99 ? '99+' : badge}
        </span>
      ) : null}
      {badge === 0 && item.shortcut ? (
        <span className="faint text-[10.5px] opacity-0 transition-opacity group-hover:opacity-100">
          {item.shortcut}
        </span>
      ) : null}
    </button>
  )
})

function SectionLabel({ children }: { children: ReactNode }): ReactNode {
  return (
    <p className="faint mb-1 mt-4 px-2.5 text-[10.5px] font-semibold uppercase tracking-wider">{children}</p>
  )
}

export const Sidebar = memo(function Sidebar(): ReactNode {
  const t = useAppStore((state) => state.t)
  const engine = useAppStore((state) => state.engine)
  const account = useAppStore((state) => state.account)
  const setAuthOpen = useUiStore((state) => state.setAuthOpen)
  const setView = useUiStore((state) => state.setView)
  const ready = engineReady(engine)

  const engineColor = ready
    ? 'var(--success)'
    : engine.state === 'downloading' || engine.state === 'checking'
      ? 'var(--warn)'
      : 'var(--danger)'

  return (
    <aside
      className="flex shrink-0 flex-col border-r"
      style={{ width: 'var(--sidebar-w)', borderColor: 'var(--border)', background: 'var(--bg-elev)' }}
    >
      <div className="flex flex-col px-2.5 pb-3">
        <SectionLabel>{t('nav.section.library')}</SectionLabel>
        <nav className="flex flex-col gap-0.5">
          {LIBRARY.map((item) => (
            <NavButton key={item.view} item={item} />
          ))}
        </nav>

        <SectionLabel>{t('nav.section.tools')}</SectionLabel>
        <nav className="flex flex-col gap-0.5">
          {TOOLS.map((item) => (
            <NavButton key={item.view} item={item} />
          ))}
        </nav>
      </div>

      <div className="mt-auto flex flex-col gap-2 border-t p-2.5" style={{ borderColor: 'var(--border)' }}>
        {/* Engine health - the single most important status in the app. */}
        <button
          type="button"
          className="no-drag flex items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-[var(--row-hover)]"
          onClick={() => setView('settings')}
          title={engine.path ?? t('engine.pill.missing')}
        >
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ background: engineColor, boxShadow: `0 0 0 3px color-mix(in srgb, ${engineColor} 22%, transparent)` }}
          />
          <span className="min-w-0 flex-1 truncate text-[11.5px] dim">
            {ready ? `ipatool ${engine.version ?? ''}`.trim() : t(`engine.state.${engine.state}`)}
          </span>
        </button>

        <button
          type="button"
          className="no-drag flex items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-[var(--row-hover)]"
          onClick={() => setAuthOpen(true)}
        >
          <span style={{ color: account ? 'var(--accent)' : 'var(--text-faint)' }}>
            <Icon name="user" size={14} />
          </span>
          <span className="min-w-0 flex-1 truncate text-[11.5px] dim">
            {account ? account.email : t('auth.signedOut')}
          </span>
        </button>
      </div>
    </aside>
  )
})
