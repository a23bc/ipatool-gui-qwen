/**
 * queue.ts hydration tests.
 *
 * `DownloadQueue.load()` is the persistence boundary: whatever was in
 * queue.json (possibly written by an older build, or hand-edited, or truncated
 * by a crash) must come back as well-formed QueueItems, with in-flight states
 * demoted to paused. The queue is constructed against a temp file; fixtures
 * deliberately avoid `queued` items so the pump cannot start a real download.
 */
import { mkdtempSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ root: '' }))

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => path.join(mocks.root, name),
    isReady: () => false,
    getLocale: () => 'en-US'
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.from(''),
    decryptString: () => ''
  },
  Notification: { isSupported: () => false }
}))

import { DownloadQueue } from '@main/queue'
import type { QueueSnapshot } from '@shared/types'

let queueFile = ''
let queue: DownloadQueue

beforeEach(async () => {
  mocks.root = mkdtempSync(path.join(os.tmpdir(), 'ipatool-queue-'))
  await mkdir(path.join(mocks.root, 'userData'), { recursive: true })
  queueFile = path.join(mocks.root, 'userData', 'queue.json')
  queue = new DownloadQueue(() => queueFile)
})

async function loadFixture(items: unknown[]): Promise<QueueSnapshot> {
  await writeFile(queueFile, JSON.stringify({ version: 1, items }), 'utf8')
  await queue.load()
  return queue.snapshot()
}

describe('DownloadQueue.load / hydrate', () => {
  it('starts empty when the queue file is missing or corrupt', async () => {
    await queue.load()
    expect(queue.snapshot().items).toEqual([])

    await writeFile(queueFile, '{ "items": [ truncated...', 'utf8')
    const queue2 = new DownloadQueue(() => queueFile)
    await queue2.load()
    expect(queue2.snapshot().items).toEqual([])
  })

  it('restores a well-formed done item', async () => {
    const snapshot = await loadFixture([
      {
        id: 'd1',
        profileId: 'p1',
        appId: 686449807,
        bundleID: 'org.telegram.Telegram',
        name: 'Telegram',
        version: '10.5.1',
        platform: 'iphone',
        externalVersionID: '86394041',
        purchase: false,
        outputDir: '/downloads',
        state: 'done',
        progress: { received: 100, total: 100, percent: 100, speed: 5, etaSec: 2 },
        outputPath: '/downloads/org.telegram.Telegram_686449807_10.5.1.ipa',
        fileSize: 100,
        error: null,
        taskId: 'old-task',
        attempts: 3,
        addedAt: 1,
        startedAt: 2,
        finishedAt: 3,
        artworkKey: 686449807
      }
    ])
    const item = snapshot.items[0]
    expect(item?.name).toBe('Telegram')
    expect(item?.state).toBe('done')
    expect(item?.purchase).toBe(false)
    expect(item?.attempts).toBe(3)
    // Volatile runtime state must not survive a restart.
    expect(item?.taskId).toBeNull()
    expect(item?.progress.speed).toBe(0)
    expect(item?.progress.etaSec).toBeNull()
  })

  it('demotes items that were running/waiting/queued mid-flight to paused', async () => {
    const snapshot = await loadFixture([
      { id: 'a', appId: 1, state: 'running', progress: { speed: 999, etaSec: 9 } },
      { id: 'b', appId: 2, state: 'waiting' },
      { id: 'c', appId: 3, state: 'paused' }
    ])
    expect(snapshot.items.map((i) => i.state)).toEqual(['paused', 'paused', 'paused'])
    expect(snapshot.items[0]?.progress.speed).toBe(0)
  })

  it('drops malformed entries but keeps the rest', async () => {
    const snapshot = await loadFixture([
      null,
      42,
      'nope',
      { noId: true },
      { id: 7 },
      { id: 'ok', appId: 5, bundleID: 'com.example.app' }
    ])
    expect(snapshot.items).toHaveLength(1)
    expect(snapshot.items[0]?.id).toBe('ok')
  })

  it('applies safe defaults to sparse items', async () => {
    const snapshot = await loadFixture([{ id: 'sparse', bundleID: 'com.example.app' }])
    const item = snapshot.items[0]
    expect(item?.name).toBe('com.example.app') // name falls back to bundleID
    expect(item?.appId).toBe(0)
    expect(item?.version).toBe('')
    expect(item?.purchase).toBe(true) // default: purchase enabled
    expect(item?.state).toBe('paused')
    expect(item?.outputDir).not.toBe('')
    expect(item?.progress).toEqual({ received: 0, total: null, percent: null, speed: 0, etaSec: null })
    expect(item?.error).toBeNull()
    expect(item?.artworkKey).toBeNull()
  })

  it('emits a snapshot when loading completes', async () => {
    const seen: QueueSnapshot[] = []
    queue.on('snapshot', (snapshot: QueueSnapshot) => seen.push(snapshot))
    await loadFixture([{ id: 'a', appId: 1 }])
    expect(seen).toHaveLength(1)
    expect(seen[0]?.items).toHaveLength(1)
  })

  it('enqueue rejects items without an app id or bundle id', async () => {
    await loadFixture([])
    const ids = queue.enqueue([
      { appId: 0, bundleID: '' },
      { name: 'nothing identifiable' }
    ])
    expect(ids).toEqual([])
    expect(queue.snapshot().items).toHaveLength(0)
  })

  it('enqueue de-duplicates against an identical pending item', async () => {
    // The existing item is pre-seeded as `paused` (not `queued`) so the pump
    // cannot start a real download chain in the test environment.
    await loadFixture([
      { id: 'existing', appId: 42, bundleID: 'com.example.app', platform: 'iphone', state: 'paused' }
    ])
    const ids = queue.enqueue([{ appId: 42, bundleID: 'com.example.app', platform: 'iphone' }])
    expect(ids).toEqual(['existing'])
    expect(queue.snapshot().items).toHaveLength(1)
  })

  it('control() ignores unknown items and clearFinished() only removes terminal items', async () => {
    await loadFixture([
      { id: 'done', appId: 1, state: 'done' },
      { id: 'err', appId: 2, state: 'error' },
      { id: 'paused', appId: 3, state: 'paused' }
    ])
    await expect(queue.control('missing', 'pause')).resolves.toBeUndefined()
    queue.clearFinished()
    const states = queue.snapshot().items.map((i) => i.id)
    expect(states).toEqual(['err', 'paused']) // 'done' removed; 'error' is kept for diagnosis
  })
})
