/**
 * Progress bus.
 *
 * Download progress arrives at ~10 Hz per item. Pushing that through React state
 * would re-render every row of the queue ten times a second, which is exactly how
 * a "smooth" download UI ends up janky. Instead progress bypasses React entirely:
 *
 *   main process -> IPC -> progressBus -> direct DOM writes on registered nodes
 *
 * Subscribers are plain callbacks that mutate `style` / `textContent`, batched
 * into one `requestAnimationFrame` flush so several items updating in the same
 * tick cost a single paint. React only re-renders when an item's *state*
 * changes (queued → running → done), which the queue snapshot store handles.
 */

export interface ProgressView {
  received: number
  total: number | null
  percent: number | null
  speed: number
  etaSec: number | null
}

type Subscriber = (progress: ProgressView) => void

const EMPTY: ProgressView = { received: 0, total: null, percent: null, speed: 0, etaSec: null }

class ProgressBus {
  private readonly latest = new Map<string, ProgressView>()
  private readonly subscribers = new Map<string, Set<Subscriber>>()
  private readonly dirty = new Set<string>()
  private frame: number | null = null

  /** Stores a sample and schedules a flush. */
  publish(id: string, progress: ProgressView): void {
    this.latest.set(id, progress)
    if (!this.subscribers.has(id)) return
    this.dirty.add(id)
    this.schedule()
  }

  private schedule(): void {
    if (this.frame !== null) return
    this.frame = requestAnimationFrame(() => {
      this.frame = null
      this.flush()
    })
  }

  private flush(): void {
    // Copy first: a subscriber may unsubscribe during the walk.
    const ids = Array.from(this.dirty)
    this.dirty.clear()
    for (const id of ids) {
      const set = this.subscribers.get(id)
      if (!set) continue
      const progress = this.latest.get(id) ?? EMPTY
      for (const subscriber of Array.from(set)) {
        try {
          subscriber(progress)
        } catch (error) {
          console.error('[progressBus] subscriber threw', error)
        }
      }
    }
  }

  subscribe(id: string, subscriber: Subscriber): () => void {
    let set = this.subscribers.get(id)
    if (!set) {
      set = new Set()
      this.subscribers.set(id, set)
    }
    set.add(subscriber)

    // Deliver the last known value immediately so a row scrolled into view (or
    // remounted by the virtualiser) is not stuck at 0% until the next tick.
    const current = this.latest.get(id)
    if (current) {
      try {
        subscriber(current)
      } catch (error) {
        console.error('[progressBus] subscriber threw', error)
      }
    }

    return () => {
      const existing = this.subscribers.get(id)
      if (!existing) return
      existing.delete(subscriber)
      if (existing.size === 0) {
        this.subscribers.delete(id)
        this.dirty.delete(id)
      }
    }
  }

  get(id: string): ProgressView {
    return this.latest.get(id) ?? EMPTY
  }

  /** Drops samples for items that left the queue. */
  forget(id: string): void {
    this.latest.delete(id)
    this.dirty.delete(id)
  }

  clear(): void {
    this.latest.clear()
    this.dirty.clear()
    if (this.frame !== null) {
      cancelAnimationFrame(this.frame)
      this.frame = null
    }
  }
}

export const progressBus = new ProgressBus()
