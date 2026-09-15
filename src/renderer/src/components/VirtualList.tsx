import { useCallback, useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'

export interface VirtualListProps<T> {
  items: T[]
  /** Fixed row height in pixels. Fixed heights keep scrolling perfectly smooth. */
  rowHeight: number
  renderItem: (item: T, index: number) => ReactNode
  keyOf: (item: T, index: number) => string
  overscan?: number
  className?: string
  /** Fired when the user scrolls near the end (infinite loading). */
  onNearEnd?: () => void
  empty?: ReactNode
  /**
   * Measure real row heights instead of assuming `rowHeight`.
   *
   * Required whenever a row's content wraps to a variable number of lines (log
   * output): a fixed height would clip everything past the first line, which is
   * exactly the "output looks incomplete" symptom.
   */
  dynamic?: boolean
  /**
   * Called with the index range currently mounted. Used for windowed fetching
   * (e.g. resolving metadata only for rows the user can actually see).
   */
  onVisibleRange?: (range: { start: number; end: number }) => void
}

/**
 * Thin wrapper over @tanstack/react-virtual.
 *
 * Only visible rows are mounted, which is what lets the search view hold
 * hundreds of results and the Activity view hold thousands of log lines without
 * scrolling turning into a slideshow.
 */
export function VirtualList<T>({
  items,
  rowHeight,
  renderItem,
  keyOf,
  overscan = 8,
  className = '',
  onNearEnd,
  empty,
  dynamic = false,
  onVisibleRange
}: VirtualListProps<T>): ReactNode {
  const scrollRef = useRef<HTMLDivElement>(null)
  const nearEndFired = useRef(false)

  // Stable identity for the virtualizer's key function; it closes over `items`
  // and `keyOf`, so it must be recreated when either changes.
  const getItemKey = useCallback(
    (index: number) => {
      const item = items[index]
      return item === undefined ? String(index) : keyOf(item, index)
    },
    [items, keyOf]
  )

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan,
    getItemKey
  })

  useEffect(() => {
    // Reset the latch when the list grows so pagination can trigger again.
    nearEndFired.current = false
  }, [items.length])

  const virtualItems = virtualizer.getVirtualItems()
  const last = virtualItems[virtualItems.length - 1]

  const firstIndex = virtualItems[0]?.index ?? -1
  const lastIndex = last?.index ?? -1

  useEffect(() => {
    if (lastIndex >= 0) onVisibleRange?.({ start: firstIndex, end: lastIndex })
  }, [firstIndex, lastIndex, onVisibleRange])

  if (onNearEnd && last && last.index >= items.length - 4 && !nearEndFired.current) {
    nearEndFired.current = true
    // Defer: never call a state setter while rendering.
    queueMicrotask(() => onNearEnd())
  }

  if (items.length === 0 && empty) {
    return (
      <div ref={scrollRef} className={`flex-1 overflow-auto ${className}`}>
        {empty}
      </div>
    )
  }

  return (
    <div ref={scrollRef} className={`flex-1 overflow-auto ${className}`}>
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
        {virtualItems.map((virtualRow) => {
          const item = items[virtualRow.index]
          if (item === undefined) return null
          return (
            <div
              key={virtualRow.key}
              data-index={virtualRow.index}
              // Lets the virtualizer read the rendered height for `dynamic`.
              ref={dynamic ? virtualizer.measureElement : undefined}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                // Fixed height only in fixed mode; dynamic rows size themselves.
                ...(dynamic ? {} : { height: rowHeight }),
                transform: `translateY(${virtualRow.start}px)`,
                contain: 'layout style paint'
              }}
            >
              {renderItem(item, virtualRow.index)}
            </div>
          )
        })}
      </div>
    </div>
  )
}
