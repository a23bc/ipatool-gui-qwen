import { describe, expect, it } from 'vitest'
import { computeStats, itemSignature, mergeSnapshot } from '@renderer/lib/queueMerge'
import type { QueueItem } from '@shared/types'

function makeItem(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id: 'd1',
    appId: 686449807,
    bundleID: 'com.example.app',
    name: 'Example',
    version: '1.0',
    platform: '',
    externalVersionID: '',
    purchase: true,
    outputDir: '/tmp/ipas',
    state: 'queued',
    accountId: 'a1bcdefg',
    progress: { received: 0, total: null, percent: null, speed: 0, etaSec: null },
    outputPath: null,
    fileSize: null,
    error: null,
    taskId: null,
    attempts: 0,
    addedAt: 0,
    startedAt: null,
    finishedAt: null,
    artworkKey: 686449807,
    ...overrides
  }
}

describe('itemSignature', () => {
  it('ignores byte-level progress so the bar never invalidates a row', () => {
    const base = { received: 0, total: 50_000_000, percent: 0, speed: 0, etaSec: null }
    const a = makeItem({ progress: base })
    const b = makeItem({
      progress: { received: 12_345, total: 50_000_000, percent: 0.02, speed: 800_000, etaSec: 90 }
    })
    expect(itemSignature(a)).toBe(itemSignature(b))
  })

  it('changes when the state changes', () => {
    expect(itemSignature(makeItem())).not.toBe(itemSignature(makeItem({ state: 'running' })))
  })

  it('changes when an error appears', () => {
    expect(itemSignature(makeItem())).not.toBe(
      itemSignature(makeItem({ state: 'error', error: { message: 'boom', hint: 'network' } }))
    )
  })

  it('changes when the total becomes known', () => {
    expect(itemSignature(makeItem())).not.toBe(
      itemSignature(makeItem({ progress: { received: 0, total: 50_000_000, percent: 0, speed: 0, etaSec: null } }))
    )
  })
})

describe('mergeSnapshot', () => {
  it('reuses previous object references for unchanged items', () => {
    const previous = [makeItem(), makeItem({ id: 'd2', name: 'Other' })]
    // Simulate a fresh allocation from the main process with only progress changed.
    const next = previous.map((item) => ({
      ...item,
      progress: { ...item.progress, received: 1234 }
    }))

    const merged = mergeSnapshot(previous, next)
    expect(merged.items[0]).toBe(previous[0])
    expect(merged.items[1]).toBe(previous[1])
    expect(merged.changed).toEqual([])
    expect(merged.structureChanged).toBe(false)
  })

  it('replaces items whose structural fields changed', () => {
    const previous = [makeItem()]
    const next = [makeItem({ state: 'running', attempts: 1 })]
    const merged = mergeSnapshot(previous, next)
    expect(merged.items[0]).not.toBe(previous[0])
    expect(merged.changed).toEqual(['d1'])
  })

  it('detects reordering and length changes as structural', () => {
    const a = makeItem({ id: 'a' })
    const b = makeItem({ id: 'b' })
    expect(mergeSnapshot([a, b], [b, a]).structureChanged).toBe(true)
    expect(mergeSnapshot([a, b], [a]).structureChanged).toBe(true)
    expect(mergeSnapshot([], [a]).structureChanged).toBe(true)
  })
})

describe('computeStats', () => {
  it('buckets every state and totals transferred bytes', () => {
    const stats = computeStats([
      makeItem({ id: '1', state: 'done' }),
      makeItem({ id: '2', state: 'running', progress: { received: 500, total: 1000, percent: 50, speed: 10, etaSec: 1 } }),
      makeItem({ id: '3', state: 'queued' }),
      makeItem({ id: '4', state: 'waiting' }),
      makeItem({ id: '5', state: 'paused' }),
      makeItem({ id: '6', state: 'error', error: { message: 'x', hint: null } }),
      makeItem({ id: '7', state: 'canceled' })
    ])
    expect(stats).toMatchObject({
      total: 7,
      done: 1,
      running: 1,
      queued: 2,
      paused: 1,
      error: 1,
      canceled: 1,
      bytesReceived: 500,
      bytesTotal: 1000
    })
  })

  it('is empty for an empty queue', () => {
    expect(computeStats([]).total).toBe(0)
  })
})
