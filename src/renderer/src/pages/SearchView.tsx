import { useCallback } from 'react'
import type { ReactNode } from 'react'
import type { StoreApp } from '@shared/types'
import { useAppStore } from '@renderer/store/app'
import { useSearchStore } from '@renderer/store/search'
import { useUiStore } from '@renderer/store/ui'
import { AppRow } from '@renderer/components/AppRow'
import { EmptyState } from '@renderer/components/EmptyState'
import { ErrorNotice } from '@renderer/components/ErrorNotice'
import { Icon, Spinner } from '@renderer/components/Icon'
import { Select } from '@renderer/components/Select'
import { VirtualList } from '@renderer/components/VirtualList'

const ROW_HEIGHT = 56

const LIMITS = [5, 10, 25, 50, 100]

export function SearchView(): ReactNode {
  const t = useAppStore((state) => state.t)
  const account = useAppStore((state) => state.account)

  const term = useSearchStore((state) => state.term)
  const setTerm = useSearchStore((state) => state.setTerm)
  const results = useSearchStore((state) => state.results)
  const query = useSearchStore((state) => state.query)
  const loading = useSearchStore((state) => state.loading)
  const error = useSearchStore((state) => state.error)
  const limit = useSearchStore((state) => state.limit)
  const setLimit = useSearchStore((state) => state.setLimit)
  const platform = useSearchStore((state) => state.platform)
  const history = useSearchStore((state) => state.history)
  const run = useSearchStore((state) => state.run)
  const clearHistory = useSearchStore((state) => state.clearHistory)
  const removeHistory = useSearchStore((state) => state.removeHistory)

  const setAuthOpen = useUiStore((state) => state.setAuthOpen)

  const keyOf = useCallback((app: StoreApp, index: number) => `${app.id}|${app.bundleID}|${index}`, [])
  const renderItem = useCallback(
    (app: StoreApp) => <AppRow app={app} platform={platform} />,
    [platform]
  )

  const showEmpty = !loading && results.length === 0 && !error

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Toolbar */}
      <div
        className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2.5"
        style={{ borderColor: 'var(--border)' }}
      >
        <span className="text-[12.5px] font-semibold">
          {loading ? t('search.searching') : query ? t('search.count', { count: results.length }) : t('nav.search')}
        </span>

        {loading ? <Spinner size={13} /> : null}

        <div className="ml-auto flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-[11.5px] dim">
            {t('search.limit')}
            <Select
              ariaLabel={t('search.limit')}
              value={limit}
              options={LIMITS.map((value) => ({ value, label: String(value) }))}
              onChange={(next) => {
                setLimit(next)
                if (query) void run()
              }}
            />
          </label>

          <button
            type="button"
            className="btn h-[26px]"
            onClick={() => void run()}
            disabled={term.trim() === '' || loading}
          >
            <Icon name="search" size={13} />
            {t('search.button')}
          </button>
        </div>
      </div>

      {/* Recent searches */}
      {history.length > 0 && showEmpty ? (
        <div
          className="flex shrink-0 flex-wrap items-center gap-1.5 border-b px-4 py-2"
          style={{ borderColor: 'var(--border)' }}
        >
          <span className="faint mr-1 text-[11px] font-semibold uppercase tracking-wider">
            {t('search.history')}
          </span>
          {history.map((entry) => (
            <span
              key={entry}
              className="badge group cursor-pointer"
              style={{ paddingRight: 3 }}
              onClick={() => {
                setTerm(entry)
                void run(entry)
              }}
            >
              <span className="max-w-[160px] truncate">{entry}</span>
              <button
                type="button"
                className="ml-0.5 rounded-full p-0.5 opacity-50 hover:opacity-100"
                onClick={(event) => {
                  event.stopPropagation()
                  removeHistory(entry)
                }}
                aria-label={t('common.delete')}
              >
                <Icon name="x" size={9} />
              </button>
            </span>
          ))}
          <button type="button" className="btn btn-ghost h-[20px] px-1.5 text-[11px]" onClick={clearHistory}>
            {t('search.clearHistory')}
          </button>
        </div>
      ) : null}

      {/* Error */}
      {error ? (
        <div className="shrink-0 px-4 pt-3">
          <ErrorNotice
            message={error.message}
            hint={error.code}
            onRetry={() => void run()}
            onViewLog={() => undefined}
          />
          {error.code === 'not-signed-in' ? (
            <button type="button" className="btn btn-primary mt-2 h-[26px]" onClick={() => setAuthOpen(true)}>
              <Icon name="user" size={13} />
              {t('auth.signIn')}
            </button>
          ) : null}
        </div>
      ) : null}

      {/* Results */}
      {results.length > 0 ? (
        <VirtualList
          items={results}
          rowHeight={ROW_HEIGHT}
          keyOf={keyOf}
          renderItem={renderItem}
          className="min-h-0"
        />
      ) : null}

      {loading && results.length === 0 ? (
        <div className="flex flex-col gap-2 px-4 py-3">
          {Array.from({ length: 8 }, (_, index) => (
            <div key={index} className="skeleton h-[44px] w-full" />
          ))}
        </div>
      ) : null}

      {showEmpty && !account ? (
        <EmptyState
          icon="user"
          title={t('auth.required.title')}
          body={t('auth.required.body')}
          tips={[t('search.empty.tip1', { key: '/' }), t('search.empty.tip2')]}
        >
          <button type="button" className="btn btn-primary" onClick={() => setAuthOpen(true)}>
            <Icon name="user" size={14} />
            {t('auth.signIn')}
          </button>
        </EmptyState>
      ) : null}

      {showEmpty && account && query === '' ? (
        <EmptyState
          icon="search"
          title={t('search.empty.title')}
          body={t('search.empty.body')}
          tips={[
            t('search.empty.tip1', { key: '/' }),
            t('search.empty.tip2'),
            t('search.empty.tip3')
          ]}
        />
      ) : null}

      {showEmpty && account && query !== '' ? (
        <EmptyState icon="search" title={t('search.none.title')} body={t('search.none.body', { term: query })} />
      ) : null}
    </div>
  )
}
