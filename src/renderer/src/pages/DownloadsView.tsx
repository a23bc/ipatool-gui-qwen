import { memo, useCallback } from 'react'
import type { ReactNode } from 'react'
import type { QueueItem } from '@shared/types'
import { IPATOOL_ERROR_CODES } from '@shared/ipatool/errors'
import type { IconName } from '@renderer/components/Icon'
import { useAppStore } from '@renderer/store/app'
import { useQueueStore } from '@renderer/store/queue'
import { useUiStore } from '@renderer/store/ui'
import { AppIcon } from '@renderer/components/AppIcon'
import { QueueStateBadge } from '@renderer/components/Badges'
import { EmptyState } from '@renderer/components/EmptyState'
import { Icon } from '@renderer/components/Icon'
import { ProgressBar } from '@renderer/components/ProgressBar'
import { Select } from '@renderer/components/Select'
import { VirtualList } from '@renderer/components/VirtualList'
import type { Key } from '@renderer/i18n'

const ROW_HEIGHT = 64

interface RowProps {
  item: QueueItem
}

function actionButton(
  key: string,
  icon: IconName,
  label: string,
  onClick: () => void,
  danger = false
): ReactNode {
  return (
    <button
      key={key}
      type="button"
      className="btn btn-ghost btn-icon h-[26px] w-[26px]"
      onClick={onClick}
      title={label}
      aria-label={label}
      style={danger ? { color: 'var(--danger)' } : undefined}
    >
      <Icon name={icon} size={14} />
    </button>
  )
}

/**
 * One queue row.
 *
 * Memoised on the item reference: the store reuses the previous object whenever
 * an item's structural signature is unchanged (see lib/queueMerge), so byte-level
 * progress never re-renders this component. The bar itself subscribes to the
 * progress bus and writes straight to the DOM.
 */
const DownloadRow = memo(function DownloadRow({ item }: RowProps): ReactNode {
  const t = useAppStore((state) => state.t)
  // Only worth showing when more than one account exists.
  const control = useQueueStore((state) => state.control)
  const deletePartial = useQueueStore((state) => state.deletePartial)
  const askConfirm = useUiStore((state) => state.askConfirm)
  const toast = useUiStore((state) => state.toast)
  const setView = useUiStore((state) => state.setView)

  const busy = item.state === 'running' || item.state === 'waiting'

  const discardPartial = async (): Promise<void> => {
    const confirmed = await askConfirm({
      title: t('downloads.deletePartial.title'),
      body: t('downloads.deletePartial.body'),
      confirmLabel: t('downloads.deletePartial.confirm'),
      danger: true
    })
    if (!confirmed) return
    const deleted = await deletePartial(item.id)
    if (deleted) {
      toast({ kind: 'success', message: t('common.done') })
      await control(item.id, 'retry')
    }
  }

  // `hint` is IPC data: only build an i18n key from codes that actually exist
  // in the dictionary, otherwise t() falls back to the raw key literal.
  const hint = item.error?.hint
  const hintKey =
    hint && (IPATOOL_ERROR_CODES as readonly string[]).includes(hint) ? `errors.${hint}.hint` : null

  return (
    <div className="row h-full" style={{ borderBottom: 'none' }}>
      <AppIcon appId={item.artworkKey ?? item.appId} name={item.name} size={34} />

      <div className="flex min-w-0 flex-1 flex-col justify-center gap-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[13px] font-medium leading-tight">{item.name}</span>
          {item.externalVersionID ? (
            <span className="mono shrink-0 faint" title={t('versions.column.externalId')}>
              #{item.externalVersionID}
            </span>
          ) : null}
          {item.platform ? <span className="badge shrink-0">{item.platform}</span> : null}
          <QueueStateBadge state={item.state} />
          <span className="mono ml-auto shrink-0 faint">{item.bundleID || `id ${item.appId}`}</span>
        </div>

        {item.state === 'error' && item.error ? (
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[11.5px]" style={{ color: 'var(--danger)' }}>
              {item.error.message}
            </span>
            {hintKey ? (
              <span className="shrink-0 truncate text-[11px] faint">{t(hintKey as Key)}</span>
            ) : null}
          </div>
        ) : (
          <ProgressBar itemId={item.id} state={item.state} />
        )}
      </div>

      <div className="flex shrink-0 items-center gap-0.5">
        {busy
          ? actionButton('pause', 'pause', t('downloads.action.pause'), () => void control(item.id, 'pause'))
          : null}

        {item.state === 'paused' || item.state === 'queued' || item.state === 'canceled'
          ? actionButton('resume', 'play', t('downloads.action.resume'), () => void control(item.id, 'resume'))
          : null}

        {item.state === 'error'
          ? actionButton('retry', 'refresh', t('downloads.action.retry'), () => void control(item.id, 'retry'))
          : null}

        {item.state === 'error' || item.state === 'paused'
          ? actionButton('delete-partial', 'trash', t('downloads.action.deletePartial'), () => void discardPartial(), true)
          : null}

        {item.state === 'done' && item.outputPath
          ? [
              actionButton('reveal', 'folder', t('downloads.action.reveal'), () =>
                void window.api.reveal(item.outputPath as string)
              ),
              actionButton('open', 'external', t('downloads.action.open'), () => {
                window.api.openPath(item.outputPath as string).catch((error: unknown) => {
                  toast({ kind: 'error', message: String(error) })
                })
              }),
              actionButton('copy-path', 'copy', t('downloads.action.copyPath'), () => {
                void window.api.copyText(item.outputPath as string)
                toast({ kind: 'success', message: t('toast.copied'), duration: 1500 })
              })
            ]
          : null}

        {item.taskId
          ? actionButton('activity', 'activity', t('nav.activity'), () => setView('activity'))
          : null}

        {busy
          ? actionButton('cancel', 'stop', t('downloads.action.cancel'), () => void control(item.id, 'cancel'), true)
          : actionButton('remove', 'x', t('downloads.action.remove'), () => void control(item.id, 'remove'), true)}
      </div>
    </div>
  )
})

export function DownloadsView(): ReactNode {
  const t = useAppStore((state) => state.t)
  const items = useQueueStore((state) => state.items)
  const stats = useQueueStore((state) => state.stats)
  const concurrency = useQueueStore((state) => state.concurrency)
  const setConcurrency = useQueueStore((state) => state.setConcurrency)
  const clearFinished = useQueueStore((state) => state.clearFinished)
  const pauseAll = useQueueStore((state) => state.pauseAll)
  const resumeAll = useQueueStore((state) => state.resumeAll)
  const importList = useQueueStore((state) => state.importList)
  const openFolder = useQueueStore((state) => state.openFolder)

  const keyOf = useCallback((item: QueueItem) => item.id, [])
  const renderItem = useCallback((item: QueueItem) => <DownloadRow item={item} />, [])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2.5"
        style={{ borderColor: 'var(--border)' }}
      >
        <span className="text-[12.5px] font-semibold">{t('downloads.title')}</span>
        <span className="faint text-[11.5px] tabular-nums">
          {t('downloads.summary', { done: stats.done, active: stats.running, queued: stats.queued })}
        </span>

        <div className="ml-auto flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-[11.5px] dim">
            {t('downloads.concurrency')}
            <Select
              ariaLabel={t('downloads.concurrency')}
              value={concurrency}
              options={[1, 2, 3, 4, 6, 8].map((value) => ({ value, label: String(value) }))}
              onChange={(value) => void setConcurrency(value)}
            />
          </label>

          <button type="button" className="btn btn-ghost h-[26px]" onClick={pauseAll} disabled={stats.running === 0}>
            <Icon name="pause" size={13} />
            {t('downloads.pauseAll')}
          </button>
          <button
            type="button"
            className="btn btn-ghost h-[26px]"
            onClick={resumeAll}
            disabled={stats.paused + stats.error === 0}
          >
            <Icon name="play" size={13} />
            {t('downloads.resumeAll')}
          </button>
          <button type="button" className="btn btn-ghost h-[26px]" onClick={() => void importList()}>
            <Icon name="file" size={13} />
            {t('downloads.import')}
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-icon h-[26px] w-[26px]"
            onClick={() => openFolder()}
            title={t('downloads.openFolder')}
          >
            <Icon name="folder" size={14} />
          </button>
          <button
            type="button"
            className="btn h-[26px]"
            onClick={() => void clearFinished()}
            disabled={stats.done + stats.canceled === 0}
          >
            <Icon name="trash" size={13} />
            {t('downloads.clearFinished')}
          </button>
        </div>
      </div>

      <VirtualList
        items={items}
        rowHeight={ROW_HEIGHT}
        keyOf={keyOf}
        renderItem={renderItem}
        className="min-h-0"
        empty={
          <EmptyState
            icon="download"
            title={t('downloads.empty.title')}
            body={t('downloads.empty.body')}
            tips={[t('downloads.resumeHint')]}
          />
        }
      />
    </div>
  )
}
