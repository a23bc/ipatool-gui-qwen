import { useCallback, useEffect } from 'react'
import type { ReactNode } from 'react'
import { formatDateOnly } from '@shared/format'
import { useAppStore } from '@renderer/store/app'
import { useQueueStore } from '@renderer/store/queue'
import { useUiStore } from '@renderer/store/ui'
import { useVersionsStore } from '@renderer/store/versions'
import { AppIcon } from '@renderer/components/AppIcon'
import { ErrorNotice } from '@renderer/components/ErrorNotice'
import { Icon, Spinner } from '@renderer/components/Icon'
import { PlatformSelect } from '@renderer/components/Badges'
import { VirtualList } from '@renderer/components/VirtualList'

const ROW_HEIGHT = 40

/**
 * Right-hand drawer listing an app's historical versions.
 *
 * Version metadata is resolved only for rows inside the visible window (see
 * store/versions.ts); scrolling resolves more, and closing the drawer stops the
 * worker pool immediately instead of letting it finish in the background.
 */
export function VersionsDrawer(): ReactNode {
  const t = useAppStore((state) => state.t)
  const app = useUiStore((state) => state.versionsFor)
  const close = useUiStore((state) => state.setVersionsFor)

  const ids = useVersionsStore((state) => state.ids)
  const meta = useVersionsStore((state) => state.meta)
  const loading = useVersionsStore((state) => state.loading)
  const working = useVersionsStore((state) => state.working)
  const error = useVersionsStore((state) => state.error)
  const platform = useVersionsStore((state) => state.platform)
  const load = useVersionsStore((state) => state.load)
  const enqueueVisible = useVersionsStore((state) => state.enqueueVisible)
  const stop = useVersionsStore((state) => state.stop)
  const closeStore = useVersionsStore((state) => state.close)
  const enqueue = useQueueStore((state) => state.enqueue)

  useEffect(() => {
    if (!app) {
      closeStore()
      return
    }
    void load(app, useVersionsStore.getState().platform)
    // Closing (or switching app) must halt metadata resolution at once.
    return () => {
      stop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app?.id, app?.bundleID])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && app) close(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [app, close])

  const onVisibleRange = useCallback(
    (range: { start: number; end: number }) => {
      const currentIds = useVersionsStore.getState().ids
      // A little lookahead so rows resolve just before they scroll into view.
      const slice = currentIds.slice(range.start, range.end + 6)
      if (slice.length > 0) enqueueVisible(slice)
    },
    [enqueueVisible]
  )

  const keyOf = useCallback((id: string) => id, [])

  const renderItem = useCallback(
    (id: string) => {
      const info = meta[id]
      const store = useVersionsStore.getState()
      return (
        <div
          className="flex h-full w-full items-center gap-2 border-b px-4"
          style={{ borderColor: 'var(--border)' }}
        >
          <span className="mono w-[110px] shrink-0 truncate tabular-nums dim" title={id}>
            {id}
          </span>
          <span className="min-w-0 flex-1 truncate text-[12.5px]">
            {info ? info.displayVersion : <span className="faint">…</span>}
          </span>
          <span className="w-[92px] shrink-0 truncate tabular-nums dim">
            {info?.releaseDate ? formatDateOnly(info.releaseDate) : <span className="faint">…</span>}
          </span>
          <button
            type="button"
            className="btn btn-ghost btn-icon h-[24px] w-[24px] shrink-0"
            title={t('versions.downloadThis')}
            onClick={() =>
              enqueue([
                {
                  appId: store.app?.id || undefined,
                  bundleID: store.app?.bundleID || undefined,
                  name: store.app?.name,
                  version: info?.displayVersion ?? '',
                  platform,
                  externalVersionID: id,
                  artworkKey: store.app?.id || undefined
                }
              ])
            }
          >
            <Icon name="download" size={13} />
          </button>
        </div>
      )
    },
    [meta, platform, enqueue, t]
  )

  if (!app) return null

  const resolvedCount = ids.filter((id) => meta[id]).length

  return (
    <>
      <div
        className="fixed inset-0 z-40"
        style={{ background: 'rgba(0,0,0,0.35)' }}
        onClick={() => close(null)}
      />
      <aside
        className="slide-in fixed right-0 top-0 z-50 flex h-full w-[460px] max-w-[92vw] flex-col border-l"
        style={{ borderColor: 'var(--border)', background: 'var(--bg-elev)', boxShadow: 'var(--shadow)' }}
        role="dialog"
        aria-modal="true"
      >
        <header
          className="flex shrink-0 items-start gap-3 border-b px-4 py-3"
          style={{ borderColor: 'var(--border)' }}
        >
          <AppIcon appId={app.id} name={app.name} size={40} radius={10} />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[14px] font-semibold">{t('versions.title')}</h2>
            <p className="mono truncate text-[11.5px] faint">
              {app.name} · {app.bundleID || `id ${app.id}`}
            </p>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            onClick={() => close(null)}
            aria-label={t('common.close')}
          >
            <Icon name="x" size={15} />
          </button>
        </header>

        <div
          className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2.5"
          style={{ borderColor: 'var(--border)' }}
        >
          <PlatformSelect
            value={platform}
            onChange={(next) => void load(app, next)}
            className="h-[26px]"
          />
          <button
            type="button"
            className="btn h-[26px]"
            onClick={() => void load(app, platform)}
            disabled={loading}
          >
            <Icon name="refresh" size={13} />
            {t('common.refresh')}
          </button>
          <button
            type="button"
            className="btn btn-primary h-[26px] ml-auto"
            onClick={() =>
              enqueue([
                {
                  appId: app.id || undefined,
                  bundleID: app.bundleID || undefined,
                  name: app.name,
                  version: app.version,
                  platform,
                  artworkKey: app.id || undefined
                }
              ])
            }
            disabled={loading}
          >
            <Icon name="download" size={13} />
            {t('versions.useLatest')}
          </button>
        </div>

        {error ? (
          <div className="shrink-0 px-4 pt-3">
            <ErrorNotice message={error.message} hint={error.code} onRetry={() => void load(app, platform)} />
          </div>
        ) : null}

        {/* Must be a flex container: VirtualList sizes itself with flex-1. */}
        <div className="flex min-h-0 flex-1 flex-col">
          {loading ? (
            <div className="flex flex-col gap-2 px-4 py-3">
              {Array.from({ length: 8 }, (_, index) => (
                <div key={index} className="skeleton h-[32px] w-full" />
              ))}
            </div>
          ) : (
            <VirtualList
              items={ids}
              rowHeight={ROW_HEIGHT}
              keyOf={keyOf}
              renderItem={renderItem}
              onVisibleRange={onVisibleRange}
              empty={<p className="px-4 py-8 text-center text-[12.5px] faint">{t('versions.empty')}</p>}
            />
          )}
        </div>

        <footer
          className="faint flex shrink-0 items-center gap-2 border-t px-4 py-2 text-[10.5px]"
          style={{ borderColor: 'var(--border)' }}
        >
          {working ? <Spinner size={11} /> : <Icon name="info" size={11} />}
          <span>
            {t('versions.lazyHint', { done: resolvedCount, total: ids.length })}
          </span>
        </footer>
      </aside>
    </>
  )
}
