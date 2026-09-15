/**
 * The download queue.
 *
 * ipatool has no daemon and no `--resume` flag, but its `downloadFile()` opens the
 * destination `.tmp`, stats it and sends `Range: bytes=<size>-` before seeking to
 * the end. That means **killing the process is a valid pause**: the partial file
 * survives, and re-running the identical command continues where it stopped. This
 * queue is built around that fact, which is why pause/resume are real operations
 * here rather than cancel-and-restart.
 *
 * Progress is fused from two independent sources:
 *   - ipatool's own progress bar, which is the only place the *total* size is
 *     known, and
 *   - polling the `.tmp` file on disk, which yields an exact byte count even if
 *     the bar's layout ever changes between ipatool releases.
 *
 * Emission is throttled (snapshots at 4 Hz, progress at 10 Hz) so a full queue
 * cannot flood the IPC channel or force the renderer to re-render at 60 Hz.
 */

import { EventEmitter } from 'node:events'
import { mkdir, readdir, readFile, rm, stat, writeFile, rename } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { DownloadRequest, Platform, ProgressEvent, QueueItem, QueueSnapshot, QueueState } from '../shared/types'
import { MovingAverage } from '../shared/format'
import { mergeProgress, type ProgressSample } from '../shared/ipatool/parse'
import { classifyError, shorten } from '../shared/ipatool/errors'
import { ApiError, ipatoolApi } from './api'
import { settingsStore } from './settings'
import { taskRegistry } from './tasks'

const SNAPSHOT_INTERVAL_MS = 250
const PROGRESS_INTERVAL_MS = 100
const POLL_INTERVAL_MS = 500
const PERSIST_DEBOUNCE_MS = 600
/** progressbar renders a bogus `(0/1 B)` blank state before the real size is known. */
const MIN_PLAUSIBLE_TOTAL = 4096
const PARTIAL_SUFFIXES = ['.ipa.tmp', '.pkg.tmp']
const FINAL_SUFFIXES = ['.ipa', '.pkg']

interface RunningDownload {
  cancel: () => void
  timer: NodeJS.Timeout | null
  pollTimer: NodeJS.Timeout | null
  stopRequested: boolean
}

export class DownloadQueue extends EventEmitter {
  private items: QueueItem[] = []
  private readonly running = new Map<string, RunningDownload>()
  private concurrency = 2
  private snapshotTimer: NodeJS.Timeout | null = null
  private readonly progressStamps = new Map<string, number>()
  private persistTimer: NodeJS.Timeout | null = null
  private started = false

  /**
   * The queue file path is resolved lazily: `app.getPath()` is only safe once
   * the app is ready, but this singleton is constructed at module load.
   */
  constructor(private readonly fileProvider: () => string) {
    super()
  }

  private get file(): string {
    return this.fileProvider()
  }

  /* ---------------------------------------------------------------- *
   * lifecycle
   * ---------------------------------------------------------------- */

  async load(): Promise<void> {
    this.concurrency = settingsStore.getInternal().concurrency
    try {
      const raw = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw) as { items?: Partial<QueueItem>[] }
      const restored = Array.isArray(parsed?.items) ? parsed.items : []
      this.items = restored.map((item) => this.hydrate(item)).filter((item): item is QueueItem => item !== null)
    } catch {
      this.items = []
    }

    const resume = settingsStore.getInternal().resumeQueueOnLaunch
    for (const item of this.items) {
      // Anything mid-flight when we last exited cannot still be running; mark it
      // paused so its partial file can be resumed deliberately.
      if (item.state === 'running' || item.state === 'waiting') item.state = 'paused'
      else if (item.state === 'queued' && !resume) item.state = 'paused'
      item.progress.speed = 0
      item.progress.etaSec = null
    }

    this.started = true
    this.emitSnapshot(true)
    if (resume) this.pump()
  }

  /** Rebuilds a persisted item, dropping fields that must not survive a restart. */
  private hydrate(raw: Partial<QueueItem>): QueueItem | null {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') return null
    const progress = raw.progress
    return {
      id: raw.id,
      appId: Number(raw.appId ?? 0),
      bundleID: String(raw.bundleID ?? ''),
      name: String(raw.name ?? raw.bundleID ?? raw.id),
      version: String(raw.version ?? ''),
      platform: (raw.platform ?? '') as Platform,
      externalVersionID: String(raw.externalVersionID ?? ''),
      purchase: raw.purchase !== false,
      outputDir: String(raw.outputDir ?? settingsStore.getInternal().downloadDir),
      state: (raw.state as QueueState) ?? 'paused',
      progress: {
        received: Number(progress?.received ?? 0),
        total: typeof progress?.total === 'number' ? progress.total : null,
        percent: typeof progress?.percent === 'number' ? progress.percent : null,
        speed: 0,
        etaSec: null
      },
      outputPath: typeof raw.outputPath === 'string' ? raw.outputPath : null,
      fileSize: typeof raw.fileSize === 'number' ? raw.fileSize : null,
      error: raw.error ?? null,
      taskId: null,
      attempts: Number(raw.attempts ?? 0),
      addedAt: Number(raw.addedAt ?? Date.now()),
      startedAt: null,
      finishedAt: typeof raw.finishedAt === 'number' ? raw.finishedAt : null,
      artworkKey: Number.isFinite(raw.artworkKey as number) ? (raw.artworkKey as number | null) : null
    }
  }

  private persist(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer)
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      void this.flush()
    }, PERSIST_DEBOUNCE_MS)
    this.persistTimer.unref?.()
  }

  /** Atomic save: temp file then rename, so a crash cannot truncate the queue. */
  private async flush(): Promise<void> {
    const payload = JSON.stringify({ version: 1, items: this.items })
    const tmp = `${this.file}.${process.pid}.tmp`
    try {
      await writeFile(tmp, payload, 'utf8')
      await rename(tmp, this.file)
    } catch {
      await rm(tmp, { force: true }).catch(() => {})
    }
  }

  shutdown(): void {
    for (const handle of this.running.values()) {
      handle.stopRequested = true
      handle.cancel()
      if (handle.timer) clearInterval(handle.timer)
      if (handle.pollTimer) clearInterval(handle.pollTimer)
    }
    this.running.clear()
    for (const item of this.items) {
      if (item.state === 'running' || item.state === 'waiting') item.state = 'paused'
    }
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer)
    if (this.persistTimer) clearTimeout(this.persistTimer)
    try {
      writeFileSync(this.file, JSON.stringify({ version: 1, items: this.items }), 'utf8')
    } catch {
      /* never block shutdown on a failed save */
    }
  }

  /* ---------------------------------------------------------------- *
   * public API
   * ---------------------------------------------------------------- */

  enqueue(requests: DownloadRequest[]): string[] {
    const settings = settingsStore.getInternal()
    const ids: string[] = []

    for (const request of requests) {
      const appId = Number(request.appId ?? 0)
      const bundleID = String(request.bundleID ?? '')
      if (!appId && !bundleID) continue

      const platform = (request.platform ?? settings.defaultPlatform ?? '') as Platform
      const externalVersionID = String(request.externalVersionID ?? '')
      const outputDir = request.outputDir?.trim() || settings.downloadDir

      // De-duplicate: the same app + version + platform is already tracked.
      const existing = this.items.find(
        (item) =>
          item.appId === appId &&
          item.bundleID === bundleID &&
          item.externalVersionID === externalVersionID &&
          item.platform === platform &&
          item.state !== 'done' &&
          item.state !== 'canceled'
      )
      if (existing) {
        ids.push(existing.id)
        continue
      }

      const id = `d${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      this.items.push({
        id,
        // Remember the account: resuming under a different session would fail
        // (or worse, purchase under the wrong Apple ID).
        appId,
        bundleID,
        name: request.name?.trim() || bundleID || `App ${appId}`,
        version: request.version ?? '',
        platform,
        externalVersionID,
        purchase: request.purchase ?? settings.autoPurchase,
        outputDir,
        state: 'queued',
        progress: { received: 0, total: null, percent: null, speed: 0, etaSec: null },
        outputPath: null,
        fileSize: null,
        error: null,
        taskId: null,
        attempts: 0,
        addedAt: Date.now(),
        startedAt: null,
        finishedAt: null,
        artworkKey: appId || null
      })
      ids.push(id)
    }

    this.persist()
    this.emitSnapshot(true)
    this.pump()
    return ids
  }

  async control(id: string, action: string): Promise<void> {
    const item = this.items.find((i) => i.id === id)
    if (!item) return

    switch (action) {
      case 'pause':
        this.stop(item, 'paused')
        break
      case 'cancel':
        this.stop(item, 'canceled')
        break
      case 'resume':
      case 'retry':
        if (item.state === 'running' || item.state === 'waiting') break
        item.error = null
        item.state = 'queued'
        item.finishedAt = null
        this.emitSnapshot(true)
        this.pump()
        break
      case 'remove':
        this.stop(item, 'canceled')
        this.items = this.items.filter((i) => i.id !== id)
        this.progressStamps.delete(id)
        this.emitSnapshot(true)
        break
      case 'move-up':
        this.reorder(id, -1)
        break
      case 'move-down':
        this.reorder(id, 1)
        break
      default:
        break
    }
    this.persist()
  }

  private reorder(id: string, delta: number): void {
    const index = this.items.findIndex((i) => i.id === id)
    const target = index + delta
    if (index < 0 || target < 0 || target >= this.items.length) return
    const [item] = this.items.splice(index, 1)
    if (!item) return
    this.items.splice(target, 0, item)
    this.emitSnapshot(true)
  }

  clearFinished(): void {
    for (const item of this.items) {
      if (item.state === 'done' || item.state === 'canceled') this.progressStamps.delete(item.id)
    }
    this.items = this.items.filter((item) => item.state !== 'done' && item.state !== 'canceled')
    this.persist()
    this.emitSnapshot(true)
  }

  setConcurrency(value: number): void {
    this.concurrency = Math.min(8, Math.max(1, Math.round(value)))
    this.emitSnapshot(true)
    this.pump()
  }

  snapshot(): QueueSnapshot {
    return {
      items: this.items.map((item) => ({ ...item, progress: { ...item.progress } })),
      concurrency: this.concurrency,
      active: this.running.size
    }
  }

  /**
   * Deletes the resumable partial file so the next attempt starts from zero.
   * Needed when Apple rejects our byte range (HTTP 416) after a long pause.
   */
  async deletePartial(id: string): Promise<{ deleted: boolean; path: string | null }> {
    const item = this.items.find((i) => i.id === id)
    if (!item) return { deleted: false, path: null }
    const tmp = await this.findTempFile(item)
    if (!tmp) return { deleted: false, path: null }
    try {
      await rm(tmp, { force: true })
      item.progress = { received: 0, total: null, percent: null, speed: 0, etaSec: null }
      this.persist()
      this.emitSnapshot(true)
      return { deleted: true, path: tmp }
    } catch {
      return { deleted: false, path: tmp }
    }
  }

  get activeCount(): number {
    return this.running.size
  }

  get hasActiveDownloads(): boolean {
    return this.running.size > 0 || this.items.some((i) => i.state === 'queued')
  }

  /* ---------------------------------------------------------------- *
   * state transitions
   * ---------------------------------------------------------------- */

  /** Kills the child (if any) and moves the item to a terminal/idle state. */
  private stop(item: QueueItem, state: Extract<QueueState, 'paused' | 'canceled'>): void {
    const handle = this.running.get(item.id)
    if (handle) {
      handle.stopRequested = true
      handle.cancel()
      if (handle.timer) clearInterval(handle.timer)
      if (handle.pollTimer) clearInterval(handle.pollTimer)
      this.running.delete(item.id)
      // The throttle stamp only matters while progress is being emitted.
      this.progressStamps.delete(item.id)
    }
    if (item.state === 'running' || item.state === 'waiting' || item.state === 'queued') {
      item.state = state
      if (state === 'canceled') item.finishedAt = Date.now()
    }
    item.progress.speed = 0
    item.progress.etaSec = null
    this.emitSnapshot(true)
    this.pump()
  }

  private pump(): void {
    if (!this.started) return
    while (this.running.size < this.concurrency) {
      const next = this.items.find((item) => item.state === 'queued')
      if (!next) break
      void this.start(next)
    }
  }

  /* ---------------------------------------------------------------- *
   * execution
   * ---------------------------------------------------------------- */

  private async start(item: QueueItem): Promise<void> {
    item.state = 'waiting'
    item.startedAt = Date.now()
    item.error = null
    item.attempts += 1
    this.emitSnapshot()

    try {
      await mkdir(item.outputDir, { recursive: true })
    } catch (error) {
      this.fail(item, `Could not create the output folder: ${(error as Error).message}`)
      return
    }

    const average = new MovingAverage(0.25)
    let sample: ProgressSample | null = null
    let lastReceived = item.progress.received
    let lastSampleAt = Date.now()

    const handle: RunningDownload = {
      cancel: () => {},
      timer: null,
      pollTimer: null,
      stopRequested: false
    }
    this.running.set(item.id, handle)

    // The task id only exists once execute() has allocated it; if the user asked
    // to stop in the meantime, cancel immediately when it arrives.
    let taskId: string | null = null
    const onTask = (id: string): void => {
      taskId = id
      item.taskId = id
      if (handle.stopRequested) taskRegistry.cancel(id)
    }
    handle.cancel = (): void => {
      if (taskId) taskRegistry.cancel(taskId)
    }

    const publish = (): void => {
      const received = Math.max(0, item.progress.received)
      const parsedTotal = sample?.total ?? null
      const total =
        parsedTotal && parsedTotal >= MIN_PLAUSIBLE_TOTAL
          ? parsedTotal
          : item.progress.total && item.progress.total >= MIN_PLAUSIBLE_TOTAL
            ? item.progress.total
            : null
      item.progress.received = received
      item.progress.total = total
      item.progress.percent =
        total && total > 0 ? Math.min(100, (received / total) * 100) : (sample?.percent ?? item.progress.percent)
      const speed = average.current
      item.progress.speed = speed
      item.progress.etaSec = total && speed > 1024 ? Math.max(0, (total - received) / speed) : null
      this.emitProgress(item)
    }

    const onProgress = (next: ProgressSample): void => {
      sample = mergeProgress(sample, next)
      if (sample?.received != null && sample.received >= item.progress.received) {
        item.progress.received = sample.received
      }
    }

    item.state = 'running'
    this.emitSnapshot()

    handle.timer = setInterval(() => {
      const now = Date.now()
      const elapsed = Math.max(0.05, (now - lastSampleAt) / 1000)
      const delta = item.progress.received - lastReceived
      if (delta > 0) average.push(delta / elapsed)
      lastReceived = item.progress.received
      lastSampleAt = now
      publish()
    }, PROGRESS_INTERVAL_MS)
    handle.timer.unref?.()

    handle.pollTimer = setInterval(() => {
      void this.readPartialSize(item).then((size) => {
        if (size !== null && size > item.progress.received) item.progress.received = size
      })
    }, POLL_INTERVAL_MS)
    handle.pollTimer.unref?.()

    // Seed the counter from an existing partial file so a resume does not
    // visually restart at 0%.
    const seeded = await this.readPartialSize(item)
    if (seeded !== null) {
      item.progress.received = Math.max(item.progress.received, seeded)
      lastReceived = item.progress.received
    }

    let outcomePath = ''
    try {
      const outcome = await ipatoolApi.download(
        {
          selector: {
            ...(item.appId ? { appId: item.appId } : {}),
            ...(item.bundleID ? { bundleID: item.bundleID } : {})
          },
          output: item.outputDir,
          ...(item.externalVersionID ? { externalVersionID: item.externalVersionID } : {}),
          ...(item.platform ? { platform: item.platform } : {}),
          purchase: item.purchase
        },
        onProgress,
        onTask
      )
      outcomePath = outcome.output
    } catch (error) {
      this.clearTimers(handle)
      this.running.delete(item.id)

      if (handle.stopRequested) {
        // stop() already moved the item to paused/canceled.
        if (item.state === 'running' || item.state === 'waiting') item.state = 'paused'
        item.progress.speed = 0
        this.emitSnapshot(true)
        this.pump()
        return
      }

      const message = error instanceof ApiError ? error.message : ((error as Error)?.message ?? 'Download failed')
      this.fail(item, message)
      return
    }

    this.clearTimers(handle)
    this.running.delete(item.id)
    this.progressStamps.delete(item.id)

    const finalPath = outcomePath || (await this.findFinishedFile(item)) || ''
    item.state = 'done'
    item.outputPath = finalPath || null
    item.finishedAt = Date.now()
    item.error = null
    item.progress.speed = 0
    item.progress.percent = 100
    if (finalPath) {
      try {
        const info = await stat(finalPath)
        item.fileSize = info.size
        item.progress.received = info.size
        item.progress.total = info.size
      } catch {
        /* the file may already have been moved by the user */
      }
    }
    this.persist()
    this.emitSnapshot(true)
    this.emit('item-finished', this.publicItem(item))
    this.pump()
  }

  private clearTimers(handle: RunningDownload): void {
    if (handle.timer) clearInterval(handle.timer)
    if (handle.pollTimer) clearInterval(handle.pollTimer)
    handle.timer = null
    handle.pollTimer = null
  }

  private fail(item: QueueItem, message: string, code?: string): void {
    const classified = classifyError(message)
    this.progressStamps.delete(item.id)
    item.state = 'error'
    item.finishedAt = Date.now()
    item.progress.speed = 0
    item.error = {
      message: shorten(classified.message || message, 500),
      // The renderer maps this code onto a translated, actionable hint.
      hint: code ?? classified.code
    }
    this.persist()
    this.emitSnapshot(true)
    this.emit('item-finished', this.publicItem(item))
    this.pump()
  }

  /* ---------------------------------------------------------------- *
   * file helpers
   * ---------------------------------------------------------------- */

  private async readPartialSize(item: QueueItem): Promise<number | null> {
    const tmp = await this.findTempFile(item)
    if (!tmp) return null
    try {
      const info = await stat(tmp)
      return info.size
    } catch {
      return null
    }
  }

  private async findTempFile(item: QueueItem): Promise<string | null> {
    const matches = await this.scanDir(item, PARTIAL_SUFFIXES)
    return matches[0] ?? null
  }

  private async findFinishedFile(item: QueueItem): Promise<string | null> {
    const matches = await this.scanDir(item, FINAL_SUFFIXES)
    return matches[0] ?? null
  }

  /**
   * Finds files belonging to this item in the output folder.
   *
   * ipatool names packages `<bundleID>_<appID>_<version>.<ext>`, so matching on
   * the app ID keeps concurrent downloads in a shared folder from picking up
   * each other's partial files. Files older than the item's start time are
   * ignored so stale leftovers from previous sessions do not confuse the counter.
   */
  private async scanDir(item: QueueItem, suffixes: string[]): Promise<string[]> {
    // Without at least one identifying token every suffixed file in the folder
    // would "belong" to this item - in a shared download directory that means
    // claiming another instance's (or the user's own) package as ours.
    if (!item.appId && !item.bundleID) return []

    let names: string[]
    try {
      names = await readdir(item.outputDir)
    } catch {
      return []
    }

    const wantsPartials = suffixes.some((s) => s.endsWith('.tmp'))
    const idToken = item.appId ? `_${item.appId}_` : ''
    const bundleToken = item.bundleID ? `${item.bundleID}_` : ''
    const since = (item.startedAt ?? item.addedAt) - 60_000

    const candidates: Array<{ full: string; mtime: number }> = []
    for (const name of names) {
      const isPartial = name.endsWith('.tmp')
      if (isPartial !== wantsPartials) continue
      if (!suffixes.some((suffix) => name.endsWith(suffix))) continue
      if (idToken && !name.includes(idToken) && !(bundleToken && name.startsWith(bundleToken))) continue
      if (!idToken && bundleToken && !name.startsWith(bundleToken)) continue

      const full = path.join(item.outputDir, name)
      try {
        const info = await stat(full)
        if (info.mtimeMs < since) continue
        candidates.push({ full, mtime: info.mtimeMs })
      } catch {
        /* vanished mid-scan */
      }
    }

    candidates.sort((a, b) => b.mtime - a.mtime)
    return candidates.map((c) => c.full)
  }

  /* ---------------------------------------------------------------- *
   * emission
   * ---------------------------------------------------------------- */

  private publicItem(item: QueueItem): QueueItem {
    return { ...item, progress: { ...item.progress } }
  }

  /** Coalesces bursts of state changes into one snapshot per tick. */
  private emitSnapshot(immediate = false): void {
    if (immediate) {
      if (this.snapshotTimer) {
        clearTimeout(this.snapshotTimer)
        this.snapshotTimer = null
      }
      this.emit('snapshot', this.snapshot())
      return
    }
    if (this.snapshotTimer) return
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = null
      this.emit('snapshot', this.snapshot())
    }, SNAPSHOT_INTERVAL_MS)
    this.snapshotTimer.unref?.()
  }

  private emitProgress(item: QueueItem): void {
    const last = this.progressStamps.get(item.id) ?? 0
    const now = Date.now()
    if (now - last < PROGRESS_INTERVAL_MS) return
    this.progressStamps.set(item.id, now)
    const event: ProgressEvent = {
      id: item.id,
      received: item.progress.received,
      total: item.progress.total,
      percent: item.progress.percent,
      speed: item.progress.speed,
      etaSec: item.progress.etaSec
    }
    this.emit('progress', event)
  }

  get queueFile(): string {
    return this.file
  }
}

/**
 * The process-wide queue. Constructed at module load, but it does not touch the
 * filesystem (or `app.getPath`) until `load()` is called after app ready.
 */
export const downloadQueue = new DownloadQueue(() => path.join(app.getPath('userData'), 'queue.json'))
