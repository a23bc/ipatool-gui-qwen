import { memo, useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import type { QueueState } from '@shared/types'
import { clampPercent, formatBytes, formatEta, formatSpeed } from '@shared/format'
import { progressBus } from '@renderer/lib/progressBus'

export interface ProgressBarProps {
  itemId: string
  state: QueueState
  /** Renders the byte/speed/ETA text next to the bar. */
  showText?: boolean
  className?: string
}

/**
 * Download progress bar.
 *
 * Deliberately *not* driven by React state. The bar subscribes to `progressBus`
 * and writes `transform: scaleX()` plus one `textContent` directly to the DOM,
 * so a 10 Hz stream of updates costs a paint rather than a re-render of the
 * whole queue. React only touches this component when the item's state changes.
 */
export const ProgressBar = memo(function ProgressBar({
  itemId,
  state,
  showText = true,
  className = ''
}: ProgressBarProps): ReactNode {
  const trackRef = useRef<HTMLDivElement>(null)
  const fillRef = useRef<HTMLDivElement>(null)
  const textRef = useRef<HTMLSpanElement>(null)
  const indeterminate = useRef<boolean | null>(null)

  const busy = state === 'running' || state === 'waiting'

  useEffect(() => {
    const setIndeterminate = (value: boolean): void => {
      if (indeterminate.current === value) return
      indeterminate.current = value
      trackRef.current?.classList.toggle('progress-indeterminate', value)
    }

    return progressBus.subscribe(itemId, (progress) => {
      const fill = fillRef.current
      if (fill) {
        if (progress.percent == null || progress.total == null) {
          // Total size is unknown until ipatool's bar renders it once; only
          // animate indeterminately while actually transferring.
          setIndeterminate(busy)
          if (!busy) fill.style.transform = 'scaleX(0)'
        } else {
          setIndeterminate(false)
          fill.style.transform = `scaleX(${(clampPercent(progress.percent) / 100).toFixed(4)})`
        }
      }

      const text = textRef.current
      if (text && showText) {
        const parts: string[] = [formatBytes(progress.received)]
        if (progress.total) parts.push(`/ ${formatBytes(progress.total)}`)
        if (progress.speed > 0 && busy) parts.push(formatSpeed(progress.speed))
        if (progress.etaSec != null && busy) parts.push(`· ${formatEta(progress.etaSec)}`)
        const next = parts.join(' ')
        // Avoid a needless text-node write, which would invalidate layout.
        if (text.textContent !== next) text.textContent = next
      }
    })
  }, [itemId, showText, busy])

  // State-driven styling changes rarely, so let React own it.
  useEffect(() => {
    const track = trackRef.current
    if (!track) return
    track.classList.toggle('progress-done', state === 'done')
    track.classList.toggle('progress-error', state === 'error')
    if (state === 'done' && fillRef.current) fillRef.current.style.transform = 'scaleX(1)'
    if (state === 'queued') {
      indeterminate.current = false
      track.classList.remove('progress-indeterminate')
    }
  }, [state])

  return (
    <div className={`flex min-w-0 flex-1 items-center gap-2 ${className}`}>
      <div ref={trackRef} className="progress">
        <div ref={fillRef} className="progress-fill" />
      </div>
      {showText ? (
        <span ref={textRef} className="mono shrink-0 tabular-nums faint" style={{ minWidth: 132 }}>
          {formatBytes(0)}
        </span>
      ) : null}
    </div>
  )
})
