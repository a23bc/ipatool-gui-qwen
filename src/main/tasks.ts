/**
 * Task registry: one record per ipatool invocation.
 *
 * Every command the UI triggers becomes a task with its own bounded log buffer,
 * so the "Activity" view can show history without leaking memory on long
 * sessions. Both the task count and the per-task line count are capped; the
 * renderer is expected to ask for older tasks explicitly.
 */

import { EventEmitter } from 'node:events'
import type { LogLine, TaskKind, TaskRecord, TaskState } from '../shared/types'
import { quoteCommand } from '../shared/format'
import { redactArgs } from '../shared/redact'

const MAX_TASKS = 200
const DEFAULT_LINE_CAP = 2000

export interface TaskHandle {
  record: TaskRecord
  /** Terminates the underlying process, if still running. */
  cancel: () => void
}

export class TaskRegistry extends EventEmitter {
  private readonly tasks = new Map<string, TaskRecord>()
  private readonly order: string[] = []
  private readonly cancellers = new Map<string, () => void>()
  private sequence = 0
  private lineCap = DEFAULT_LINE_CAP

  setLineCap(cap: number): void {
    this.lineCap = Math.max(100, cap)
    for (const task of this.tasks.values()) {
      if (task.lines.length > this.lineCap) {
        task.lines.splice(0, task.lines.length - this.lineCap)
      }
    }
  }

  create(kind: TaskKind, label: string, args: string[], secrets: string[] = []): TaskHandle {
    this.sequence += 1
    const id = `t${Date.now().toString(36)}-${this.sequence}`
    // The command shown in the UI must never contain a password or 2FA code.
    const command = `ipatool ${quoteCommand(redactArgs(args))}`
    const record: TaskRecord = {
      id,
      kind,
      label,
      state: 'running',
      startedAt: Date.now(),
      endedAt: null,
      command: secrets.length > 0 ? `${command} [redacted]` : command,
      exitCode: null,
      lines: []
    }

    this.tasks.set(id, record)
    this.order.push(id)
    this.evict()
    this.emit('created', this.snapshot(record))
    return {
      record,
      cancel: () => {
        const fn = this.cancellers.get(id)
        if (fn) fn()
      }
    }
  }

  registerCanceller(id: string, cancel: () => void): void {
    this.cancellers.set(id, cancel)
  }

  log(id: string, line: Omit<LogLine, 't'>): void {
    const task = this.tasks.get(id)
    if (!task) return
    const entry: LogLine = { t: Date.now(), ...line }
    task.lines.push(entry)
    if (task.lines.length > this.lineCap) {
      // Drop from the front in slices; shifting one at a time is O(n^2).
      task.lines.splice(0, task.lines.length - this.lineCap)
    }
    this.emit('log', { taskId: id, line: entry })
  }

  system(id: string, text: string, level: LogLine['level'] = 'info'): void {
    this.log(id, { stream: 'system', level, text })
  }

  finish(id: string, state: TaskState, exitCode: number | null): TaskRecord | null {
    const task = this.tasks.get(id)
    if (!task) return null
    task.state = state
    task.exitCode = exitCode
    task.endedAt = Date.now()
    this.cancellers.delete(id)
    const snapshot = this.snapshot(task)
    this.emit('finished', snapshot)
    return snapshot
  }

  get(id: string): TaskRecord | null {
    const task = this.tasks.get(id)
    return task ? this.snapshot(task) : null
  }

  list(): TaskRecord[] {
    return this.order.map((id) => this.tasks.get(id)).filter(Boolean).map((t) => this.snapshot(t!)).reverse()
  }

  /** Number of tasks currently running. */
  runningCount(): number {
    let n = 0
    for (const task of this.tasks.values()) if (task.state === 'running') n += 1
    return n
  }

  clear(): void {
    for (const id of this.order) {
      const task = this.tasks.get(id)
      if (task?.state === 'running') this.cancellers.get(id)?.()
    }
    this.tasks.clear()
    this.order.length = 0
    this.cancellers.clear()
  }

  /** Cancels a single running task. Returns false when it is not running. */
  cancel(id: string): boolean {
    const cancel = this.cancellers.get(id)
    if (!cancel) return false
    cancel()
    return true
  }

  /** Cancels every running task (used on app quit). */
  cancelAll(): void {
    for (const fn of this.cancellers.values()) fn()
    this.cancellers.clear()
  }

  private evict(): void {
    while (this.order.length > MAX_TASKS) {
      const oldest = this.order.shift()
      if (!oldest) break
      const task = this.tasks.get(oldest)
      // Never evict something still running; drop the next oldest instead.
      if (task?.state === 'running') {
        this.order.push(oldest)
        // Guard against an infinite loop when every task is running.
        if (this.order.every((id) => this.tasks.get(id)?.state === 'running')) break
        continue
      }
      this.tasks.delete(oldest)
      this.cancellers.delete(oldest)
    }
  }

  /** Detaches the mutable log array so the renderer gets a stable snapshot. */
  private snapshot(task: TaskRecord): TaskRecord {
    return { ...task, lines: task.lines.slice(-500) }
  }
}

export const taskRegistry = new TaskRegistry()
