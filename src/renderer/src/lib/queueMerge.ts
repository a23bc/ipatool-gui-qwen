/**
 * Queue snapshot merging.
 *
 * The main process pushes a full snapshot ~4 times a second, and every object in
 * it is freshly allocated. Assigning that straight into the store would defeat
 * `React.memo` on every row and re-render the whole queue four times a second.
 *
 * So we compare a cheap signature per item and *reuse the previous object
 * reference* when nothing structural changed. Byte counters are deliberately
 * excluded from the signature: they live on the progress bus and are written
 * directly to the DOM, never through React.
 */

import type { QueueItem } from '@shared/types'

/** Fields whose change must cause a row to re-render. */
export function itemSignature(item: QueueItem): string {
  return [
    item.id,
    item.state,
    item.attempts,
    item.name,
    item.version,
    item.bundleID,
    item.appId,
    item.platform,
    item.externalVersionID,
    item.outputDir,
    item.outputPath ?? '',
    item.fileSize ?? '',
    item.error?.message ?? '',
    item.error?.hint ?? '',
    item.purchase ? 1 : 0,
    item.taskId ?? '',
    // Which Apple ID the download runs as: constant for the life of an item, but
    // part of the signature so a row can never show a stale account label.
    item.accountId,
    // `total` is structural: it flips a row from indeterminate to determinate.
    item.progress.total ?? ''
  ].join('|')
}

export interface MergedSnapshot {
  items: QueueItem[]
  /** True when the item list itself changed length or order. */
  structureChanged: boolean
  /** Ids whose signature changed. */
  changed: string[]
}

export function mergeSnapshot(previous: QueueItem[], next: QueueItem[]): MergedSnapshot {
  if (previous.length === 0) {
    return { items: next, structureChanged: true, changed: next.map((i) => i.id) }
  }

  const before = new Map<string, { item: QueueItem; signature: string }>()
  for (const item of previous) {
    before.set(item.id, { item, signature: itemSignature(item) })
  }

  const changed: string[] = []
  const merged = next.map((item) => {
    const prior = before.get(item.id)
    if (!prior) {
      changed.push(item.id)
      return item
    }
    if (prior.signature === itemSignature(item)) {
      // Structurally identical: hand back the old reference so memoised rows
      // skip re-rendering entirely.
      return prior.item
    }
    changed.push(item.id)
    return item
  })

  const structureChanged =
    previous.length !== next.length || previous.some((item, index) => item.id !== next[index]?.id)

  return { items: merged, structureChanged, changed }
}

export interface QueueStats {
  total: number
  queued: number
  running: number
  paused: number
  done: number
  error: number
  canceled: number
  bytesReceived: number
  bytesTotal: number
}

export function computeStats(items: QueueItem[]): QueueStats {
  const stats: QueueStats = {
    total: items.length,
    queued: 0,
    running: 0,
    paused: 0,
    done: 0,
    error: 0,
    canceled: 0,
    bytesReceived: 0,
    bytesTotal: 0
  }
  for (const item of items) {
    switch (item.state) {
      case 'queued':
      case 'waiting':
        stats.queued += 1
        break
      case 'running':
        stats.running += 1
        stats.bytesReceived += item.progress.received
        if (item.progress.total) stats.bytesTotal += item.progress.total
        break
      case 'paused':
        stats.paused += 1
        break
      case 'done':
        stats.done += 1
        break
      case 'error':
        stats.error += 1
        break
      case 'canceled':
        stats.canceled += 1
        break
      default:
        break
    }
  }
  return stats
}
