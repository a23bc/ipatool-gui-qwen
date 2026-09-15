import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TaskRegistry } from '@main/tasks'
import type { TaskRecord } from '@shared/types'

describe('TaskRegistry', () => {
  let reg: TaskRegistry

  beforeEach(() => {
    reg = new TaskRegistry()
  })

  it('creates a running task with a redacted command line', () => {
    const handle = reg.create('search', 'Search "telegram"', ['search', 'telegram'], [])
    expect(handle.record.state).toBe('running')
    expect(handle.record.label).toBe('Search "telegram"')
    expect(handle.record.command).toBe('ipatool search telegram')
    expect(reg.get(handle.record.id)?.state).toBe('running')
    expect(reg.runningCount()).toBe(1)
  })

  it('masks secret-bearing argv in the stored command', () => {
    const handle = reg.create(
      'login',
      'Login',
      ['auth', 'login', '-e', 'me@example.com', '-p', 'hunter2'],
      ['hunter2']
    )
    expect(handle.record.command).not.toContain('hunter2')
    expect(handle.record.command).toContain('[redacted]')
  })

  it('emits created / log / finished events', () => {
    const created: TaskRecord[] = []
    const logs: unknown[] = []
    const finished: TaskRecord[] = []
    reg.on('created', (task: TaskRecord) => created.push(task))
    reg.on('log', (payload: unknown) => logs.push(payload))
    reg.on('finished', (task: TaskRecord) => finished.push(task))

    const handle = reg.create('search', 'l', ['search'], [])
    reg.log(handle.record.id, { stream: 'stdout', level: 'info', text: 'hello' })
    reg.finish(handle.record.id, 'succeeded', 0)

    expect(created).toHaveLength(1)
    expect(logs).toHaveLength(1)
    expect(finished[0]?.state).toBe('succeeded')
    expect(finished[0]?.exitCode).toBe(0)
  })

  it('log() appends lines and respects the line cap (minimum 100)', () => {
    const handle = reg.create('search', 'l', ['search'], [])
    reg.setLineCap(5) // clamped up to the 100-line floor
    for (let i = 0; i < 150; i += 1) {
      reg.log(handle.record.id, { stream: 'stdout', level: 'info', text: `line ${i}` })
    }
    const snap = reg.get(handle.record.id)
    expect(snap?.lines).toHaveLength(100)
    expect(snap?.lines[0]?.text).toBe('line 50')
    expect(snap?.lines.at(-1)?.text).toBe('line 149')
  })

  it('system() writes a system-stream line', () => {
    const handle = reg.create('download', 'd', ['download'], [])
    reg.system(handle.record.id, 'exec: ipatool download', 'debug')
    const line = reg.get(handle.record.id)?.lines[0]
    expect(line?.stream).toBe('system')
    expect(line?.level).toBe('debug')
  })

  it('finish() moves the task to a terminal state and stamps endedAt', () => {
    const handle = reg.create('search', 'l', ['search'], [])
    const before = Date.now()
    const finished = reg.finish(handle.record.id, 'failed', 3)
    expect(finished?.state).toBe('failed')
    expect(finished?.exitCode).toBe(3)
    expect(finished?.endedAt).toBeGreaterThanOrEqual(before)
    expect(reg.runningCount()).toBe(0)
  })

  it('evicts the oldest finished tasks once MAX_TASKS is exceeded', () => {
    for (let i = 0; i < 250; i += 1) {
      const handle = reg.create('search', `l${i}`, ['search'], [])
      reg.finish(handle.record.id, 'succeeded', 0)
    }
    expect(reg.list()).toHaveLength(200)
    // Newest first.
    expect(reg.list()[0]?.label).toBe('l249')
  })

  it('never evicts a running task', () => {
    const running = reg.create('download', 'slow', ['download'], [])
    for (let i = 0; i < 250; i += 1) {
      const handle = reg.create('search', `l${i}`, ['search'], [])
      reg.finish(handle.record.id, 'succeeded', 0)
    }
    expect(reg.get(running.record.id)).not.toBeNull()
  })

  it('cancel() invokes the registered canceller and reports unknown ids', () => {
    const handle = reg.create('download', 'd', ['download'], [])
    const cancel = vi.fn()
    reg.registerCanceller(handle.record.id, cancel)
    expect(reg.cancel(handle.record.id)).toBe(true)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(reg.cancel('nope')).toBe(false)
  })

  it('cancelAll() hard-cancels every running task and clears the registry of cancellers', () => {
    const a = reg.create('download', 'a', ['download'], [])
    const b = reg.create('download', 'b', ['download'], [])
    const hardFlags: Array<boolean | undefined> = []
    reg.registerCanceller(a.record.id, (hard) => hardFlags.push(hard))
    reg.registerCanceller(b.record.id, (hard) => hardFlags.push(hard))

    reg.cancelAll()
    expect(hardFlags).toEqual([true, true])

    // A second pass must be a no-op (cancellers were cleared).
    reg.cancelAll()
    expect(hardFlags).toHaveLength(2)
  })

  it('clear() cancels running tasks and empties everything', () => {
    const cancel = vi.fn()
    const handle = reg.create('download', 'd', ['download'], [])
    reg.registerCanceller(handle.record.id, cancel)
    reg.clear()
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(reg.list()).toHaveLength(0)
    expect(reg.get(handle.record.id)).toBeNull()
  })

  it('snapshots cap the exported line array at 500 while the buffer holds more', () => {
    const handle = reg.create('search', 'l', ['search'], [])
    reg.setLineCap(1000)
    for (let i = 0; i < 700; i += 1) {
      reg.log(handle.record.id, { stream: 'stdout', level: 'info', text: `line ${i}` })
    }
    expect(reg.get(handle.record.id)?.lines).toHaveLength(500)
    expect(reg.get(handle.record.id)?.lines.at(-1)?.text).toBe('line 699')
  })

  it('logs for unknown task ids are ignored', () => {
    expect(() => reg.log('missing', { stream: 'stdout', level: 'info', text: 'x' })).not.toThrow()
    expect(reg.finish('missing', 'succeeded', 0)).toBeNull()
  })
})
