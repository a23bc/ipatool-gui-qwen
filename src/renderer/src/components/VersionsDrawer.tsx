import { useEffect, useMemo } from 'react'
import type { ReactNode } from 'react'
import type { Platform } from '@shared/types'
import { formatDateOnly } from '@shared/format'
import { useAppStore } from '@renderer/store/app'
import { useQueueStore } from '@renderer/store/queue'
import { useUiStore } from '@renderer/store/ui'
import { useVersionsStore } from '@renderer/store/versions'
import { AppIcon } from '@renderer/components/AppIcon'
import { ErrorNotice } from '@renderer/components/ErrorNotice'
import { Icon, Spinner } from '@renderer/components/Icon'
import { PlatformSelect } from '@renderer/components/Badges'

/**
 * Right-hand drawer listing an app's historical versions.
 *
 * ipatool returns opaque external identifiers, so the human-readable version and
 * release date are fetched on demand ("Resolve names") with bounded concurrency
 * and cached - resolving 200 versions eagerly would be slow and rate-limit bait.
 */
export function VersionsDrawer(): ReactNode {
  const t = useAppStore((state) => state.t)
  const app = useUiStore((state) => state.versionsFor)
  const close = useUiStore((state) => state.setVersionsFor)

  const ids = useVersionsStore((state) => state.ids)
  const meta = useVersionsStore((state) => state.meta)
  const loading = useVersionsStore((state) => state.loading)
  const resolving = useVersionsStore((state) => state.resolving)
  const resolvedCount = useVersionsStore((state) => state.resolvedCount)
  const totalToResolve = useVersionsStore((state) => state.totalToResolve)
  const error = useVersionsStore((state) => state.error)
  const platform = useVersionsStore((state) => state.platform)
  const load = useVersionsStore((state) => state.load)
  const resolveAll = useVersionsStore((state) => state.resolveAll)
  const closeVersions = useVersionsStore((state) => state.close)
  const enqueue = useQueueStore((state) => state.enqueue)

  useEffect(() => {
    if (!app) {
      closeVersions()
      return
    }
    // Read the current platform through getState() rather than closing over the
    // rendered value: this effect only re-runs when the app changes, so a
    // captured `platform` would go stale after the user switches device family.
    void load(app, useVersionsStore.getState().platform)
  }, [app, load, closeVersions])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && app) close(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [app, close])

  const latest = useMemo(() => ids[0] ?? null, [ids])

  if (!app) return null

  const changePlatform = (next: Platform): void => {
    void load(app, next)
  }

  const download = (externalVersionID?: string): void => {
    void enqueue([
      {
        appId: app.id || undefined,
        bundleID: app.bundleID || undefined,
        name: app.name,
        version: externalVersionID ? (meta[externalVersionID]?.displayVersion ?? '') : app.version,
        platform,
        ...(externalVersionID ? { externalVersionID } : {}),
        artworkKey: app.id || undefined
      }
    ])
  }

  return (
    <>
      <div
        className="fixed inset-0 z-40"
        style={{ background: 'rgba(0,0,0,0.35)' }}
        onClick={() => close(null)}
      />
      <aside
        className="slide-in fixed right-0 top-0 z-50 flex h-full w-[440px] max-w-[92vw] flex-col border-l"
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
          <button type="button" className="btn btn-ghost btn-icon" onClick={() => close(null)} aria-label={t('common.close')}>
            <Icon name="x" size={15} />
          </button>
        </header>

        <div
          className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2.5"
          style={{ borderColor: 'var(--border)' }}
        >
          <PlatformSelect value={platform} onChange={changePlatform} className="h-[26px]" />

          <button
            type="button"
            className="btn h-[26px]"
            onClick={() => void load(app, platform)}
            disabled={loading || resolving}
          >
            <Icon name="refresh" size={13} />
            {t('common.refresh')}
          </button>

          <button
            type="button"
            className="btn h-[26px] ml-auto"
            onClick={() => void resolveAll()}
            disabled={loading || resolving || ids.length === 0}
            title={t('versions.explain')}
          >
            {resolving ? <Spinner size={13} /> : <Icon name="list" size={13} />}
            {resolving
              ? t('versions.resolving', { done: resolvedCount, total: totalToResolve })
              : t('versions.resolve')}
          </button>

          <button type="button" className="btn btn-primary h-[26px]" onClick={() => download()} disabled={loading}>
            <Icon name="download" size={13} />
            {t('versions.useLatest')}
          </button>
        </div>

        {error ? (
          <div className="shrink-0 px-4 pt-3">
            <ErrorNotice message={error.message} hint={error.code} onRetry={() => void load(app, platform)} />
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-auto">
          {loading ? (
            <div className="flex flex-col gap-2 px-4 py-3">
              {Array.from({ length: 8 }, (_, index) => (
                <div key={index} className="skeleton h-[40px] w-full" />
              ))}
            </div>
          ) : null}

          {!loading && ids.length === 0 && !error ? (
            <p className="px-4 py-8 text-center text-[12.5px] faint">{t('versions.empty')}</p>
          ) : null}

          {!loading && ids.length > 0 ? (
            <table className="w-full border-collapse text-[12px]">
              <thead>
                <tr className="faint text-left text-[10.5px] uppercase tracking-wider">
                  <th className="sticky top-0 px-4 py-2 font-semibold" style={{ background: 'var(--bg-elev)' }}>
                    {t('versions.column.externalId')}
                  </th>
                  <th className="sticky top-0 px-2 py-2 font-semibold" style={{ background: 'var(--bg-elev)' }}>
                    {t('versions.column.displayVersion')}
                  </th>
                  <th className="sticky top-0 px-2 py-2 font-semibold" style={{ background: 'var(--bg-elev)' }}>
                    {t('versions.column.releaseDate')}
                  </th>
                  <th className="sticky top-0 px-4 py-2" style={{ background: 'var(--bg-elev)' }} />
                </tr>
              </thead>
              <tbody>
                {ids.map((id) => {
                  const info = meta[id]
                  return (
                    <tr
                      key={id}
                      className="border-t transition-colors hover:bg-[var(--row-hover)]"
                      style={{ borderColor: 'var(--border)' }}
                    >
                      <td className="mono px-4 py-2 tabular-nums">
                        <span className="flex items-center gap-1.5">
                          {id}
                          {id === latest ? (
                            <span className="badge badge-accent">{t('versions.latest')}</span>
                          ) : null}
                        </span>
                      </td>
                      <td className="px-2 py-2">{info?.displayVersion ?? <span className="faint">—</span>}</td>
                      <td className="px-2 py-2 tabular-nums dim">
                        {info?.releaseDate ? formatDateOnly(info.releaseDate) : <span className="faint">—</span>}
                      </td>
                      <td className="px-4 py-2 text-right">
                        <button
                          type="button"
                          className="btn btn-ghost btn-icon h-[24px] w-[24px]"
                          title={t('versions.downloadThis')}
                          onClick={() => download(id)}
                        >
                          <Icon name="download" size={13} />
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          ) : null}
        </div>

        <footer
          className="faint shrink-0 border-t px-4 py-2 text-[10.5px] leading-relaxed"
          style={{ borderColor: 'var(--border)' }}
        >
          {t('versions.explain')}
        </footer>
      </aside>
    </>
  )
}
