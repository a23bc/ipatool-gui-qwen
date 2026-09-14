import { memo } from 'react'
import type { ReactNode } from 'react'
import type { Platform, StoreApp } from '@shared/types'
import { useAppStore } from '@renderer/store/app'
import { useQueueStore } from '@renderer/store/queue'
import { useUiStore } from '@renderer/store/ui'
import { AppIcon } from './AppIcon'
import { PriceBadge, PlatformBadges } from './Badges'
import { Icon } from './Icon'

export interface AppRowProps {
  app: StoreApp
  platform: Platform
  /** Renders a checkbox for batch operations. */
  selectable?: boolean
  selected?: boolean
  onToggleSelect?: (key: string) => void
  /** Renders a leading index/purchase-date column instead of the icon gutter. */
  trailing?: ReactNode
  rowHeight?: number
}

function storeUrl(app: StoreApp): string {
  return app.id > 0
    ? `https://apps.apple.com/app/id${app.id}`
    : `https://apps.apple.com/search?term=${encodeURIComponent(app.bundleID)}`
}

/**
 * One App Store entry. Shared by Search and Purchases so both lists behave and
 * look identical. Memoised: with a virtualised parent, a row only re-renders when
 * its own props change.
 */
export const AppRow = memo(function AppRow({
  app,
  platform,
  selectable = false,
  selected = false,
  onToggleSelect,
  trailing
}: AppRowProps): ReactNode {
  const t = useAppStore((state) => state.t)
  const enqueue = useQueueStore((state) => state.enqueue)
  const setVersionsFor = useUiStore((state) => state.setVersionsFor)
  const toast = useUiStore((state) => state.toast)

  const key = `${app.id}|${app.bundleID}`

  const download = (): void => {
    void enqueue([
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

  const purchase = async (): Promise<void> => {
    const result = await window.api.purchase(
      { appId: app.id || undefined, bundleID: app.bundleID || undefined },
      platform || undefined
    )
    if (result.ok) {
      toast({
        kind: 'success',
        message: result.data.alreadyOwned
          ? t('search.purchase.owned', { name: app.name })
          : t('search.purchase.done', { name: app.name })
      })
    } else {
      toast({ kind: 'error', message: result.error, detail: result.hint ?? undefined })
    }
  }

  const copy = async (text: string): Promise<void> => {
    await window.api.copyText(text)
    toast({ kind: 'success', message: t('toast.copied'), duration: 1600 })
  }

  return (
    <div
      className={`row h-full ${selected ? 'row-selected' : ''}`}
      style={{ borderBottom: 'none' }}
      data-row-key={key}
    >
      {selectable ? (
        <input
          type="checkbox"
          className="no-drag h-3.5 w-3.5 shrink-0 cursor-pointer"
          style={{ accentColor: 'var(--accent)' }}
          checked={selected}
          onChange={() => onToggleSelect?.(key)}
          aria-label={app.name}
        />
      ) : null}

      <AppIcon appId={app.id} name={app.name} size={34} />

      <div className="flex min-w-0 flex-1 flex-col justify-center">
        <span className="truncate text-[13px] font-medium leading-tight">{app.name || app.bundleID}</span>
        <span className="mono mt-0.5 truncate faint">{app.bundleID || `id ${app.id}`}</span>
      </div>

      {trailing}

      <PlatformBadges platforms={app.platforms} />

      <span className="mono w-[74px] shrink-0 truncate text-right dim" title={app.version}>
        {app.version || '—'}
      </span>

      <span className="w-[64px] shrink-0 text-right">
        <PriceBadge price={app.price} />
      </span>

      <div className="flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          className="btn btn-icon h-[26px] w-[26px]"
          onClick={download}
          title={t('search.action.download')}
        >
          <Icon name="download" size={14} />
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-icon h-[26px] w-[26px]"
          onClick={() => setVersionsFor(app)}
          title={t('search.action.versions')}
        >
          <Icon name="history" size={14} />
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-icon h-[26px] w-[26px]"
          onClick={() => void purchase()}
          title={t('search.action.purchase')}
        >
          <Icon name="key" size={14} />
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-icon h-[26px] w-[26px]"
          onClick={() => void copy(app.bundleID || String(app.id))}
          title={t('search.action.copyBundleId')}
        >
          <Icon name="copy" size={14} />
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-icon h-[26px] w-[26px]"
          onClick={() => void window.api.openExternal(storeUrl(app))}
          title={t('search.action.openStore')}
        >
          <Icon name="external" size={14} />
        </button>
      </div>
    </div>
  )
})
