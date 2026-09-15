/**
 * Download queue state.
 *
 * Snapshots are merged (see `lib/queueMerge`) so unchanged rows keep their object
 * identity, and byte-level progress never enters React at all - it is forwarded
 * straight to `progressBus`, which writes to the DOM.
 */

import { create } from 'zustand'
import type { DownloadRequest, QueueItem } from '@shared/types'
import type { QueueAction } from '@shared/ipc'
import { computeStats, mergeSnapshot, type QueueStats } from '@renderer/lib/queueMerge'
import { progressBus } from '@renderer/lib/progressBus'
import { useUiStore } from './ui'
import { useAppStore } from './app'

const EMPTY_STATS: QueueStats = {
  total: 0,
  queued: 0,
  running: 0,
  paused: 0,
  done: 0,
  error: 0,
  canceled: 0,
  bytesReceived: 0,
  bytesTotal: 0
}

export interface QueueState {
  items: QueueItem[]
  stats: QueueStats
  concurrency: number
  active: number
  initialised: boolean

  init: () => Promise<void>
  enqueue: (requests: DownloadRequest[]) => Promise<string[]>
  control: (id: string, action: QueueAction) => Promise<void>
  clearFinished: () => Promise<void>
  setConcurrency: (value: number) => Promise<void>
  deletePartial: (id: string) => Promise<boolean>
  importList: () => Promise<number>
  pauseAll: () => void
  resumeAll: () => void
  openFolder: (item?: QueueItem) => void
}

let subscriptionsActive = false
let disposers: Array<() => void> = []

/** Detaches the queue's IPC listeners (HMR teardown / unit tests). */
export function disposeQueueStore(): void {
  for (const dispose of disposers) dispose()
  disposers = []
  subscriptionsActive = false
}

export const useQueueStore = create<QueueState>()((set, get) => ({
  items: [],
  stats: EMPTY_STATS,
  concurrency: 2,
  active: 0,
  initialised: false,

  async init() {
    const snapshot = await window.api.getQueue()
    set({
      items: snapshot.items,
      stats: computeStats(snapshot.items),
      concurrency: snapshot.concurrency,
      active: snapshot.active,
      initialised: true
    })

    if (subscriptionsActive) return
    subscriptionsActive = true

    disposers.push(window.api.on('queue:snapshot', (next) => {
      const merged = mergeSnapshot(get().items, next.items)
      set({
        items: merged.items,
        stats: computeStats(merged.items),
        concurrency: next.concurrency,
        active: next.active
      })

      // Drop samples for items that are gone so the bus cannot grow forever.
      if (merged.structureChanged) {
        const alive = new Set(next.items.map((item) => item.id))
        for (const previous of get().items) {
          if (!alive.has(previous.id)) progressBus.forget(previous.id)
        }
      }
    }))

    disposers.push(window.api.on('queue:progress', (event) => {
      progressBus.publish(event.id, {
        received: event.received,
        total: event.total,
        percent: event.percent,
        speed: event.speed,
        etaSec: event.etaSec
      })
    }))

    disposers.push(window.api.on('queue:item-finished', (item) => {
      const { t } = useAppStore.getState()
      if (item.state === 'done') {
        useUiStore.getState().toast({
          kind: 'success',
          message: t('toast.downloadDone', { name: item.name }),
          ...(item.outputPath
            ? {
                actionLabel: t('downloads.action.reveal'),
                onAction: () => void window.api.reveal(item.outputPath as string)
              }
            : {})
        })
      } else if (item.state === 'error') {
        useUiStore.getState().toast({
          kind: 'error',
          message: t('toast.downloadFailed', { name: item.name }),
          detail: item.error?.message
        })
      }
    }))
  },

  async enqueue(requests) {
    if (requests.length === 0) return []
    const ids = await window.api.enqueue({ items: requests })
    const { t } = useAppStore.getState()
    useUiStore.getState().toast({
      kind: 'success',
      message:
        ids.length === 1
          ? t('search.enqueue.success')
          : t('search.enqueue.many', { n: ids.length }),
      actionLabel: t('nav.downloads'),
      onAction: () => useUiStore.getState().setView('downloads')
    })
    return ids
  },

  async control(id, action) {
    await window.api.controlQueue(id, action)
    if (action === 'remove') progressBus.forget(id)
  },

  async clearFinished() {
    await window.api.clearFinished()
    // No local progressBus cleanup here: `get().items` is still the pre-clear
    // snapshot at this point, so the old "forget dead ids" loop could never
    // see a difference. The queue:snapshot handler's structureChanged branch
    // already forgets every removed item once the real snapshot arrives.
  },

  async setConcurrency(value) {
    await window.api.setConcurrency(value)
    set({ concurrency: value })
  },

  async deletePartial(id) {
    const result = await window.api.deletePartial(id)
    return result.deleted
  },

  async importList() {
    const count = await window.api.importQueueFile()
    const { t } = useAppStore.getState()
    useUiStore
      .getState()
      .toast(
        count > 0
          ? { kind: 'success', message: t('toast.imported', { n: count }) }
          : { kind: 'warn', message: t('toast.importEmpty') }
      )
    return count
  },

  pauseAll() {
    for (const item of get().items) {
      if (item.state === 'running' || item.state === 'queued' || item.state === 'waiting') {
        void window.api.controlQueue(item.id, 'pause')
      }
    }
  },

  resumeAll() {
    for (const item of get().items) {
      if (item.state === 'paused' || item.state === 'error') {
        void window.api.controlQueue(item.id, 'resume')
      }
    }
  },

  openFolder(item) {
    const target = item?.outputDir ?? useAppStore.getState().settings.downloadDir
    if (item?.outputPath) {
      void window.api.reveal(item.outputPath)
      return
    }
    if (target) {
      // The main process now refuses paths outside its allow-list; surface a
      // rejection instead of dropping an unhandled promise on the floor.
      window.api.openPath(target).catch((error: unknown) => {
        useUiStore.getState().toast({ kind: 'error', message: String(error) })
      })
    }
  }
}))
