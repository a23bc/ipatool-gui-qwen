import { useCallback, useMemo } from 'react'
import type { ReactNode } from 'react'
import type { Platform, StoreApp } from '@shared/types'
import { useAppStore } from '@renderer/store/app'
import { usePurchasesStore, appKey, visibleApps } from '@renderer/store/purchases'
import { useQueueStore } from '@renderer/store/queue'
import { useUiStore } from '@renderer/store/ui'
import { AppRow } from '@renderer/components/AppRow'
import { EmptyState } from '@renderer/components/EmptyState'
import { ErrorNotice } from '@renderer/components/ErrorNotice'
import { Icon, Spinner } from '@renderer/components/Icon'
import { PlatformSelect } from '@renderer/components/Badges'
import { VirtualList } from '@renderer/components/VirtualList'

const ROW_HEIGHT = 56

/**
 * Apps owned by the signed-in Apple ID.
 *
 * Every store field is read through its own selector: zustand actions have stable
 * identities, so subscribing to them individually costs nothing and keeps the
 * row list from re-rendering when an unrelated field (like `loading`) flips.
 */
export function PurchasesView(): ReactNode {
  const t = useAppStore((state) => state.t)
  const account = useAppStore((state) => state.account)
  const settings = useAppStore((state) => state.settings)

  const apps = usePurchasesStore((state) => state.apps)
  const filter = usePurchasesStore((state) => state.filter)
  const selection = usePurchasesStore((state) => state.selection)
  const platform = usePurchasesStore((state) => state.platform)
  const page = usePurchasesStore((state) => state.page)
  const totalCount = usePurchasesStore((state) => state.totalCount)
  const loading = usePurchasesStore((state) => state.loading)
  const loaded = usePurchasesStore((state) => state.loaded)
  const error = usePurchasesStore((state) => state.error)

  const load = usePurchasesStore((state) => state.load)
  const loadMore = usePurchasesStore((state) => state.loadMore)
  const setFilter = usePurchasesStore((state) => state.setFilter)
  const setPlatform = usePurchasesStore((state) => state.setPlatform)
  const toggle = usePurchasesStore((state) => state.toggle)
  const clearSelection = usePurchasesStore((state) => state.clearSelection)

  const enqueue = useQueueStore((state) => state.enqueue)
  const setAuthOpen = useUiStore((state) => state.setAuthOpen)

  const rows = useMemo(() => visibleApps(apps, filter), [apps, filter])
  const hasMore = totalCount > 0 ? apps.length < totalCount : false
  const paidCount = useMemo(() => apps.filter((app) => app.price > 0).length, [apps])

  const keyOf = useCallback((app: StoreApp, index: number) => `${appKey(app)}|${index}`, [])

  const renderItem = useCallback(
    (app: StoreApp) => (
      <AppRow
        app={app}
        platform={platform}
        selectable
        selected={selection.includes(appKey(app))}
        onToggleSelect={toggle}
      />
    ),
    [platform, selection, toggle]
  )

  const downloadSelected = (): void => {
    const chosen = apps.filter((app) => selection.includes(appKey(app)))
    if (chosen.length === 0) return
    void enqueue(
      chosen.map((app) => ({
        appId: app.id || undefined,
        bundleID: app.bundleID || undefined,
        name: app.name,
        version: app.version,
        platform: platform as Platform,
        artworkKey: app.id || undefined
      }))
    )
    clearSelection()
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2.5"
        style={{ borderColor: 'var(--border)' }}
      >
        <span className="text-[12.5px] font-semibold">{t('purchases.title')}</span>
        {loaded ? (
          <span className="faint text-[11.5px] tabular-nums">
            {t('purchases.total', { count: apps.length, total: totalCount })}
          </span>
        ) : null}
        {loading ? <Spinner size={13} /> : null}

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {selection.length > 0 ? (
            <>
              <span className="badge badge-accent">{t('purchases.selected', { n: selection.length })}</span>
              <button type="button" className="btn h-[26px]" onClick={downloadSelected}>
                <Icon name="download" size={13} />
                {t('purchases.downloadSelected')}
              </button>
              <button type="button" className="btn btn-ghost h-[26px]" onClick={clearSelection}>
                {t('purchases.clearSelection')}
              </button>
            </>
          ) : null}

          <div className="relative">
            <span
              className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2"
              style={{ color: 'var(--text-faint)' }}
            >
              <Icon name="filter" size={12} />
            </span>
            <input
              className="input h-[26px] w-[180px] pl-7"
              value={filter}
              placeholder={t('purchases.filter')}
              onChange={(event) => setFilter(event.target.value)}
              spellCheck={false}
            />
          </div>

          <PlatformSelect
            value={platform}
            onChange={(next) => setPlatform(next)}
            className="max-w-[160px]"
          />

          <button
            type="button"
            className="btn h-[26px]"
            onClick={() => void load(1, false)}
            disabled={loading || !account}
          >
            <Icon name="refresh" size={13} />
            {loaded ? t('common.refresh') : t('purchases.load')}
          </button>
        </div>
      </div>

      {error ? (
        <div className="shrink-0 px-4 pt-3">
          <ErrorNotice
            message={error.message}
            hint={error.code}
            onRetry={() => void load(page, false)}
            onViewLog={() => undefined}
          />
        </div>
      ) : null}

      {rows.length > 0 ? (
        <VirtualList
          items={rows}
          rowHeight={ROW_HEIGHT}
          keyOf={keyOf}
          renderItem={renderItem}
          className="min-h-0"
          onNearEnd={hasMore && !loading ? () => void loadMore() : undefined}
        />
      ) : null}

      {loaded && rows.length > 0 && hasMore ? (
        <div className="flex shrink-0 justify-center border-t py-2" style={{ borderColor: 'var(--border)' }}>
          <button type="button" className="btn h-[26px]" onClick={() => void loadMore()} disabled={loading}>
            {loading ? <Spinner size={12} /> : <Icon name="chevronDown" size={12} />}
            {t('common.showMore')}
          </button>
        </div>
      ) : null}

      {!loaded && !account ? (
        <EmptyState icon="user" title={t('auth.required.title')} body={t('auth.required.body')}>
          <button type="button" className="btn btn-primary" onClick={() => setAuthOpen(true)}>
            <Icon name="user" size={14} />
            {t('auth.signIn')}
          </button>
        </EmptyState>
      ) : null}

      {!loaded && account ? (
        <EmptyState icon="layers" title={t('purchases.empty.title')} body={t('purchases.empty.body')}>
          <button type="button" className="btn btn-primary" onClick={() => void load(1, false)}>
            <Icon name="refresh" size={14} />
            {t('purchases.load')}
          </button>
        </EmptyState>
      ) : null}

      {loaded && rows.length === 0 && !loading ? (
        <EmptyState icon="layers" title={t('purchases.empty.title')} body={t('purchases.subtitle')} />
      ) : null}

      {loaded && apps.length > 0 ? (
        <div
          className="faint flex shrink-0 items-center gap-3 border-t px-4 py-1.5 text-[11px]"
          style={{ borderColor: 'var(--border)' }}
        >
          <span>
            {t('purchases.page', { page })} · {t('purchases.pageSize')} {settings.purchasesPageSize}
          </span>
          {paidCount > 0 ? <span>{t('purchases.paidCount', { n: paidCount })}</span> : null}
        </div>
      ) : null}
    </div>
  )
}
