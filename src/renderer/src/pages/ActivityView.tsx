import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { LogLine, TaskRecord } from '@shared/types'
import { formatDuration } from '@shared/format'
import { useAppStore } from '@renderer/store/app'
import { useTasksStore } from '@renderer/store/tasks'
import { useUiStore } from '@renderer/store/ui'
import { EmptyState } from '@renderer/components/EmptyState'
import { Icon } from '@renderer/components/Icon'
import { TaskStateBadge } from '@renderer/components/Badges'
import { VirtualList } from '@renderer/components/VirtualList'

const TASK_ROW = 52
const LOG_ROW = 19

const LEVEL_COLOR: Record<LogLine['level'], string> = {
  info: 'var(--text-dim)',
  debug: 'var(--text-faint)',
  warn: 'var(--warn)',
  error: 'var(--danger)',
  progress: 'var(--accent)'
}

const TaskRow = memo(function TaskRow({
  task,
  selected,
  onSelect
}: {
  task: TaskRecord
  selected: boolean
  onSelect: (id: string) => void
}): ReactNode {
  return (
    <button
      type="button"
      onClick={() => onSelect(task.id)}
      className="flex h-full w-full flex-col justify-center gap-1 border-b px-3 text-left transition-colors"
      style={{
        borderColor: 'var(--border)',
        background: selected ? 'var(--row-selected)' : 'transparent'
      }}
    >
      <span className="flex w-full items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{task.label}</span>
        <TaskStateBadge state={task.state} />
      </span>
      <span className="mono flex w-full items-center gap-1.5 truncate faint">
        <span className="truncate">{task.kind}</span>
        <span>·</span>
        <span className="shrink-0 tabular-nums">
          {task.endedAt
            ? formatDuration((task.endedAt - task.startedAt) / 1000)
            : formatDuration((Date.now() - task.startedAt) / 1000)}
        </span>
      </span>
    </button>
  )
})

const LogRow = memo(function LogRow({
  line,
  selected,
  onSelect
}: {
  line: LogLine
  selected: boolean
  onSelect: (line: LogLine) => void
}): ReactNode {
  return (
    <button
      type="button"
      onClick={() => onSelect(line)}
      className="log-line flex h-full w-full items-center gap-2 px-3 text-left"
      style={{
        color: LEVEL_COLOR[line.level],
        background: selected ? 'var(--row-selected)' : 'transparent'
      }}
      title={line.text.length > 100 ? 'Click to view the full line' : undefined}
    >
      <span className="shrink-0 tabular-nums" style={{ color: 'var(--text-faint)' }}>
        {new Date(line.t).toISOString().slice(11, 19)}
      </span>
      {/* Fixed-height virtual rows cannot show wrapped text, so clip to one
          line; the full content is available in the detail pane below. */}
      <span className="min-w-0 flex-1 truncate">{line.text}</span>
    </button>
  )
})

export function ActivityView(): ReactNode {
  const t = useAppStore((state) => state.t)
  const tasks = useTasksStore((state) => state.tasks)
  const lines = useTasksStore(state => state.lines)
  const selectedId = useTasksStore((state) => state.selectedId)
  const filter = useTasksStore((state) => state.filter)
  const select = useTasksStore((state) => state.select)
  const setFilter = useTasksStore((state) => state.setFilter)
  const clear = useTasksStore((state) => state.clear)
  const exportLogs = useTasksStore((state) => state.exportLogs)
  const cancel = useTasksStore((state) => state.cancel)
  const toast = useUiStore((state) => state.toast)

  // The line currently expanded in the detail pane (fixed-height rows clip).
  const [expanded, setExpanded] = useState<LogLine | null>(null)

  const selected = useMemo(
    () => tasks.find((task) => task.id === selectedId) ?? null,
    [tasks, selectedId]
  )

  const visibleLines = useMemo(() => {
    if (!selectedId) return []
    const all = lines[selectedId] ?? []
    const needle = filter.trim().toLowerCase()
    if (!needle) return all
    return all.filter((line) => line.text.toLowerCase().includes(needle))
  }, [lines, selectedId, filter])

  const taskKey = useCallback((task: TaskRecord) => task.id, [])
  const renderTask = useCallback(
    (task: TaskRecord) => (
      <TaskRow task={task} selected={task.id === selectedId} onSelect={select} />
    ),
    [selectedId, select]
  )

  useEffect(() => {
    setExpanded(null)
  }, [selectedId])

  const lineKey = useCallback((line: LogLine, index: number) => `${line.t}-${index}`, [])
  const renderLine = useCallback(
    (line: LogLine) => <LogRow line={line} selected={expanded === line} onSelect={setExpanded} />,
    [expanded]
  )

  return (
    <div className="flex min-h-0 flex-1">
      {/* Task list */}
      <div
        className="flex w-[280px] shrink-0 flex-col border-r"
        style={{ borderColor: 'var(--border)', background: 'var(--bg-elev)' }}
      >
        <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2" style={{ borderColor: 'var(--border)' }}>
          <span className="text-[12px] font-semibold">{t('activity.task')}</span>
          <span className="faint text-[11px] tabular-nums">{tasks.length}</span>
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              className="btn btn-ghost btn-icon h-[24px] w-[24px]"
              title={t('common.export')}
              onClick={() => {
                void exportLogs().then((saved) => {
                  if (saved) toast({ kind: 'success', message: saved })
                })
              }}
            >
              <Icon name="file" size={13} />
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-icon h-[24px] w-[24px]"
              title={t('activity.clear')}
              onClick={() => void clear()}
            >
              <Icon name="trash" size={13} />
            </button>
          </div>
        </div>

        <VirtualList
          items={tasks}
          rowHeight={TASK_ROW}
          keyOf={taskKey}
          renderItem={renderTask}
          className="min-h-0"
          empty={<p className="px-3 py-6 text-center text-[12px] faint">{t('activity.empty')}</p>}
        />
      </div>

      {/* Log detail */}
      <div className="flex min-w-0 flex-1 flex-col">
        {selected ? (
          <>
            <div
              className="flex shrink-0 flex-col gap-2 border-b px-4 py-2.5"
              style={{ borderColor: 'var(--border)' }}
            >
              <div className="flex items-center gap-2">
                <span className="truncate text-[12.5px] font-semibold">{selected.label}</span>
                <TaskStateBadge state={selected.state} />
                {selected.exitCode !== null ? (
                  <span className="mono faint">exit {selected.exitCode}</span>
                ) : null}
                <span className="mono faint tabular-nums">
                  {formatDuration(((selected.endedAt ?? Date.now()) - selected.startedAt) / 1000)}
                </span>

                <div className="ml-auto flex items-center gap-1.5">
                  <div className="relative">
                    <span
                      className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2"
                      style={{ color: 'var(--text-faint)' }}
                    >
                      <Icon name="filter" size={11} />
                    </span>
                    <input
                      className="input h-[24px] w-[160px] pl-6 text-[11.5px]"
                      value={filter}
                      placeholder={t('activity.filter')}
                      onChange={(event) => setFilter(event.target.value)}
                      spellCheck={false}
                    />
                  </div>
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon h-[24px] w-[24px]"
                    title={t('activity.copyCommand')}
                    onClick={() => {
                      void window.api.copyText(selected.command)
                      toast({ kind: 'success', message: t('toast.copied'), duration: 1500 })
                    }}
                  >
                    <Icon name="copy" size={12} />
                  </button>
                  {selected.state === 'running' ? (
                    <button
                      type="button"
                      className="btn btn-danger h-[24px] px-2"
                      onClick={() => void cancel(selected.id)}
                    >
                      <Icon name="stop" size={11} />
                      {t('activity.cancel')}
                    </button>
                  ) : null}
                </div>
              </div>

              <code
                className="mono block truncate rounded px-2 py-1"
                style={{ background: 'var(--panel-2)', color: 'var(--text-dim)' }}
                title={selected.command}
              >
                {selected.command}
              </code>
            </div>

            <VirtualList
              items={visibleLines}
              rowHeight={LOG_ROW}
              keyOf={lineKey}
              renderItem={renderLine}
              className="min-h-0"
              empty={
                <p className="px-4 py-6 text-center text-[12px] faint">{t('console.noOutput')}</p>
              }
            />

            {expanded ? (
              <div
                className="flex max-h-[40%] shrink-0 flex-col border-t px-4 py-2"
                style={{ borderColor: 'var(--border)', background: 'var(--panel)' }}
              >
                <div className="mb-1.5 flex shrink-0 items-center gap-2">
                  <span className="mono faint">{new Date(expanded.t).toISOString()}</span>
                  <span className="badge">
                    {expanded.stream}/{expanded.level}
                  </span>
                  <div className="ml-auto flex items-center gap-1">
                    <button
                      type="button"
                      className="btn btn-ghost btn-icon h-[24px] w-[24px]"
                      title={t('common.copy')}
                      onClick={() => {
                        void window.api.copyText(expanded.text)
                        toast({ kind: 'success', message: t('toast.copied'), duration: 1500 })
                      }}
                    >
                      <Icon name="copy" size={12} />
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-icon h-[24px] w-[24px]"
                      title={t('common.close')}
                      onClick={() => setExpanded(null)}
                    >
                      <Icon name="x" size={12} />
                    </button>
                  </div>
                </div>
                <pre
                  className="log-line min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded p-2"
                  style={{ background: 'var(--panel-2)' }}
                >
                  {expanded.text}
                </pre>
              </div>
            ) : null}
          </>
        ) : (
          <EmptyState icon="activity" title={t('activity.title')} body={t('activity.subtitle')} />
        )}

        <div
          className="faint flex shrink-0 items-center gap-2 border-t px-4 py-1.5 text-[10.5px]"
          style={{ borderColor: 'var(--border)' }}
        >
          <Icon name="key" size={11} />
          {t('activity.redacted')}
        </div>
      </div>
    </div>
  )
}
