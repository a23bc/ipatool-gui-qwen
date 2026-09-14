/**
 * Task history and log state.
 *
 * ipatool's download progress rewrites its line ~15 times a second. Forwarding
 * every one of those into a log array would balloon memory and make the Activity
 * view unusable, so consecutive progress renders collapse into a single,
 * continuously-updated line.
 */

import { create } from 'zustand'
import type { LogLine, TaskRecord } from '@shared/types'
import { useAppStore } from './app'

const DEFAULT_CAP = 2000

export interface TasksState {
  tasks: TaskRecord[]
  lines: Record<string, LogLine[]>
  selectedId: string | null
  filter: string
  initialised: boolean

  init: () => Promise<void>
  select: (id: string | null) => void
  setFilter: (filter: string) => void
  clear: () => Promise<void>
  exportLogs: () => Promise<string | null>
  cancel: (id: string) => Promise<void>
}

let subscriptionsActive = false

function capFor(): number {
  return useAppStore.getState().settings.maxLogLines || DEFAULT_CAP
}

export const useTasksStore = create<TasksState>()((set, get) => ({
  tasks: [],
  lines: {},
  selectedId: null,
  filter: '',
  initialised: false,

  async init() {
    const tasks = await window.api.listTasks()
    const lines: Record<string, LogLine[]> = {}
    for (const task of tasks) lines[task.id] = task.lines
    set({ tasks, lines, initialised: true })

    if (subscriptionsActive) return
    subscriptionsActive = true

    window.api.on('task:created', (task) => {
      set((state) => ({
        tasks: [task, ...state.tasks.filter((t) => t.id !== task.id)],
        lines: { ...state.lines, [task.id]: [] }
      }))
      // Follow the newest task automatically when nothing is selected.
      if (!get().selectedId) set({ selectedId: task.id })
    })

    window.api.on('task:log', ({ taskId, line }) => {
      set((state) => {
        const existing = state.lines[taskId]
        const cap = capFor()
        let next: LogLine[]

        if (!existing) {
          next = [line]
        } else if (line.level === 'progress') {
          // Collapse a run of progress renders into the last entry. The level is
          // stamped by the runner, which can see the raw (pre-ANSI-strip) text -
          // guessing from the cleaned line would risk swallowing JSON output
          // that merely happens to contain a '%' character.
          const previous = existing[existing.length - 1]
          next =
            previous && previous.level === 'progress'
              ? existing.slice(0, -1).concat(line)
              : existing.concat(line)
        } else {
          next = existing.concat(line)
        }

        if (next.length > cap) next = next.slice(next.length - cap)
        return { lines: { ...state.lines, [taskId]: next } }
      })
    })

    window.api.on('task:finished', (task) => {
      set((state) => ({
        tasks: state.tasks.map((existing) => (existing.id === task.id ? { ...existing, ...task } : existing))
      }))
    })
  },

  select(selectedId) {
    set({ selectedId })
  },

  setFilter(filter) {
    set({ filter })
  },

  async clear() {
    await window.api.clearTasks()
    set({ tasks: [], lines: {}, selectedId: null })
  },

  async exportLogs() {
    return window.api.exportTasks()
  },

  async cancel(id) {
    await window.api.cancelTask(id)
  }
}))

/** Filtered lines for the selected task, memo-friendly. */
export function selectVisibleLines(state: TasksState): LogLine[] {
  if (!state.selectedId) return []
  const lines = state.lines[state.selectedId] ?? []
  const needle = state.filter.trim().toLowerCase()
  if (!needle) return lines
  return lines.filter((line) => line.text.toLowerCase().includes(needle))
}
