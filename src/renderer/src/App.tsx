import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { useAppStore } from '@renderer/store/app'
import { useQueueStore } from '@renderer/store/queue'
import { useTasksStore } from '@renderer/store/tasks'
import { useUiStore, VIEWS, type View } from '@renderer/store/ui'
import { CommandPalette } from '@renderer/components/CommandPalette'
import { AccountManager } from '@renderer/components/AccountManager'
import { ConfirmDialog } from '@renderer/components/ConfirmDialog'
import { EngineSetup } from '@renderer/components/EngineSetup'
import { Header, StatusBar } from '@renderer/components/Header'
import { Sidebar } from '@renderer/components/Sidebar'
import { Spinner } from '@renderer/components/Icon'
import { Toasts } from '@renderer/components/Toasts'
import { VersionsDrawer } from '@renderer/components/VersionsDrawer'
import { ActivityView } from '@renderer/pages/ActivityView'
import { AuthModal } from '@renderer/pages/AuthModal'
import { ConsoleView } from '@renderer/pages/ConsoleView'
import { DownloadsView } from '@renderer/pages/DownloadsView'
import { PurchasesView } from '@renderer/pages/PurchasesView'
import { SearchView } from '@renderer/pages/SearchView'
import { SettingsView } from '@renderer/pages/SettingsView'

/** Digit shortcuts map onto sidebar order, so 1..6 jumps between views. */
const VIEW_SHORTCUTS: Record<string, View> = {
  '1': 'search',
  '2': 'purchases',
  '3': 'downloads',
  '4': 'activity',
  '5': 'console'
}

function CurrentView({ view }: { view: View }): ReactNode {
  switch (view) {
    case 'search':
      return <SearchView />
    case 'purchases':
      return <PurchasesView />
    case 'downloads':
      return <DownloadsView />
    case 'activity':
      return <ActivityView />
    case 'console':
      return <ConsoleView />
    case 'settings':
      return <SettingsView />
    default:
      return <SearchView />
  }
}

export function App(): ReactNode {
  const ready = useAppStore((state) => state.ready)
  const initApp = useAppStore((state) => state.init)
  const initQueue = useQueueStore((state) => state.init)
  const initTasks = useTasksStore((state) => state.init)
  const view = useUiStore((state) => state.view)
  const setView = useUiStore((state) => state.setView)
  const versionsFor = useUiStore((state) => state.versionsFor)

  // Boot the stores. Each store guards against double-initialisation, so this is
  // safe under StrictMode's double effect invocation.
  useEffect(() => {
    void (async () => {
      await initApp()
      await Promise.all([initQueue(), initTasks()])
    })()
  }, [initApp, initQueue, initTasks])

  // Global shortcuts: Ctrl/Cmd+1..5 switch views, Ctrl/Cmd+, opens settings.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey)) return
      const target = event.target as HTMLElement | null
      const typing =
        target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)

      if (event.key === ',') {
        event.preventDefault()
        setView('settings')
        return
      }
      // Allow digit shortcuts while typing so they stay discoverable, but never
      // swallow them inside the palette's own input.
      if (typing && useUiStore.getState().paletteOpen) return
      const mapped = VIEW_SHORTCUTS[event.key]
      if (mapped) {
        event.preventDefault()
        setView(mapped)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setView])

  // (No global Escape handler here on purpose: it used to call
  // setPaletteOpen(false) only when the palette was already closed - a no-op.
  // The overlays that need Escape each own a handler: Modal captures it at the
  // document level, CommandPalette and VersionsDrawer listen on window.)

  if (!ready) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <Spinner size={20} />
        <p className="faint text-[12px]">{useAppStore.getState().t('common.loading')}</p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <Header />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="flex min-w-0 flex-1 flex-col" style={{ background: 'var(--bg)' }}>
          <CurrentView view={view} />
        </main>
      </div>
      <StatusBar />

      {/* Overlays. Order matters for stacking: drawer under palette. */}
      {versionsFor ? <VersionsDrawer /> : null}
      <EngineSetup />
      <AccountManager />
      <AuthModal />
      <CommandPalette />
      <ConfirmDialog />
      <Toasts />
    </div>
  )
}

export { VIEWS }
