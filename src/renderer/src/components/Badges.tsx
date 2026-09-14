import type { ReactNode } from 'react'
import type { Platform, QueueState, TaskState } from '@shared/types'
import { useAppStore } from '@renderer/store/app'
import { Icon, type IconName } from './Icon'

/** Renders the platform tokens ipatool reports for an app. */
export function PlatformBadges({ platforms }: { platforms?: string[] }): ReactNode {
  if (!platforms || platforms.length === 0) return null
  return (
    <span className="flex shrink-0 items-center gap-1">
      {platforms.slice(0, 4).map((platform) => (
        <span key={platform} className="badge" title={platform}>
          {platform}
        </span>
      ))}
      {platforms.length > 4 ? <span className="badge">+{platforms.length - 4}</span> : null}
    </span>
  )
}

/** Selectable platform options, in the order ipatool documents them. */
export const PLATFORM_OPTIONS: Array<{ value: Platform; labelKey: string }> = [
  { value: '', labelKey: 'platform.auto' },
  { value: 'iphone', labelKey: 'platform.iphone' },
  { value: 'ipad', labelKey: 'platform.ipad' },
  { value: 'appletv', labelKey: 'platform.appletv' },
  { value: 'visionos', labelKey: 'platform.visionos' },
  { value: 'macos', labelKey: 'platform.macos' }
]

export interface PlatformSelectProps {
  value: Platform
  onChange: (value: Platform) => void
  className?: string
  id?: string
}

export function PlatformSelect({ value, onChange, className = '', id }: PlatformSelectProps): ReactNode {
  const t = useAppStore((state) => state.t)
  return (
    <select
      id={id}
      className={`select no-drag ${className}`}
      value={value}
      onChange={(event) => onChange(event.target.value as Platform)}
    >
      {PLATFORM_OPTIONS.map((option) => (
        <option key={option.value || 'auto'} value={option.value}>
          {t(option.labelKey)}
        </option>
      ))}
    </select>
  )
}

const QUEUE_STATE_META: Record<QueueState, { className: string; icon: IconName }> = {
  queued: { className: '', icon: 'clock' },
  waiting: { className: 'badge-accent', icon: 'loader' },
  running: { className: 'badge-accent', icon: 'download' },
  paused: { className: 'badge-warn', icon: 'pause' },
  done: { className: 'badge-success', icon: 'checkCircle' },
  error: { className: 'badge-danger', icon: 'xCircle' },
  canceled: { className: '', icon: 'xCircle' }
}

export function QueueStateBadge({ state }: { state: QueueState }): ReactNode {
  const t = useAppStore((status) => status.t)
  const meta = QUEUE_STATE_META[state] ?? QUEUE_STATE_META.queued
  return (
    <span className={`badge shrink-0 ${meta.className}`}>
      <Icon
        name={meta.icon}
        size={11}
        className={state === 'waiting' || state === 'running' ? 'spinner' : undefined}
      />
      {t(`downloads.state.${state}`)}
    </span>
  )
}

const TASK_STATE_META: Record<TaskState, string> = {
  running: 'badge-accent',
  succeeded: 'badge-success',
  failed: 'badge-danger',
  canceled: ''
}

export function TaskStateBadge({ state }: { state: TaskState }): ReactNode {
  const t = useAppStore((status) => status.t)
  return <span className={`badge shrink-0 ${TASK_STATE_META[state] ?? ''}`}>{t(`activity.state.${state}`)}</span>
}

/** Free / paid price label. ipatool reports 0 for free apps. */
export function PriceBadge({ price }: { price: number }): ReactNode {
  const t = useAppStore((state) => state.t)
  if (!price || price <= 0) {
    return <span className="badge badge-success shrink-0">{t('search.free')}</span>
  }
  return <span className="badge shrink-0">{t('search.paid', { price: price.toFixed(2) })}</span>
}
