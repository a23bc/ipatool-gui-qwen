import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { quoteCommand } from '@shared/format'
import { redactArgs } from '@shared/redact'
import { useAppStore } from '@renderer/store/app'
import { useTasksStore } from '@renderer/store/tasks'
import { useUiStore } from '@renderer/store/ui'
import { ErrorNotice } from '@renderer/components/ErrorNotice'
import { Icon, Spinner } from '@renderer/components/Icon'

// Only read-only subcommands are allowed here (the main process enforces an
// allow-list): sign-in, downloads and purchases go through the dedicated UI,
// which carries 2FA handling, profile scoping and credential storage.
const EXAMPLES: Array<{ args: string; note: string }> = [
  { args: 'auth info', note: 'current session' },
  { args: 'search telegram --limit 10', note: 'search' },
  { args: 'list-versions -i 686449807', note: 'version history by app id' },
  { args: 'list-purchases -l 50 -p 1', note: 'first page of owned apps' },
  { args: 'get-version-metadata -i 686449807 --external-version-id 86394041', note: 'version metadata' }
]

/**
 * Splits a command line into argv the way a shell would, honouring single and
 * double quotes so arguments can contain spaces (app names, paths).
 */
export function parseArgv(input: string): string[] {
  const out: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let hasToken = false

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]
    // Unreachable inside the loop bounds; keeps the compiler honest under
    // noUncheckedIndexedAccess without changing behaviour.
    if (char === undefined) break
    if (quote) {
      if (char === quote) {
        quote = null
      } else if (char === '\\' && quote === '"' && i + 1 < input.length) {
        i += 1
        current += input[i] ?? ''
      } else {
        current += char
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      hasToken = true
      continue
    }
    if (char === '\\' && i + 1 < input.length) {
      i += 1
      current += input[i] ?? ''
      hasToken = true
      continue
    }
    if (/\s/.test(char)) {
      if (hasToken) {
        out.push(current)
        current = ''
        hasToken = false
      }
      continue
    }
    current += char
    hasToken = true
  }
  if (hasToken) out.push(current)
  return out
}

export function ConsoleView(): ReactNode {
  const t = useAppStore((state) => state.t)
  const engine = useAppStore((state) => state.engine)
  const [input, setInput] = useState('')
  const [interactive, setInteractive] = useState(false)
  const [running, setRunning] = useState(false)
  const [output, setOutput] = useState('')
  const [error, setError] = useState<{ message: string; code: string | null } | null>(null)
  const select = useTasksStore((state) => state.select)
  const setView = useUiStore((state) => state.setView)

  // Memoised: parseArgv rescans the whole input on every keystroke otherwise.
  const argv = useMemo(() => parseArgv(input), [input])
  const preview = argv.length > 0 ? `ipatool ${quoteCommand(redactArgs(argv))}` : ''

  const run = async (): Promise<void> => {
    if (argv.length === 0 || running) return
    setRunning(true)
    setError(null)
    setOutput('')

    try {
      const result = await window.api.runRaw({ args: argv, interactive })
      if (result.ok) {
        setOutput(result.data || t('console.noOutput'))
        select(result.taskId)
      } else {
        setOutput('')
        setError({ message: result.error, code: result.code })
        select(result.taskId)
      }
    } catch (error) {
      // Bridge-level rejection: show it instead of stranding the Run button.
      setOutput('')
      setError({ message: String(error), code: null })
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className="flex shrink-0 flex-col gap-2.5 border-b px-4 py-3"
        style={{ borderColor: 'var(--border)' }}
      >
        <div className="flex items-center gap-2">
          <span className="text-[12.5px] font-semibold">{t('console.title')}</span>
          <span className="faint text-[11.5px]">{t('console.subtitle')}</span>
          {engine.version ? <span className="badge badge-accent ml-auto">ipatool {engine.version}</span> : null}
        </div>

        <div className="flex items-center gap-2">
          <span className="mono shrink-0" style={{ color: 'var(--accent)' }}>
            ipatool
          </span>
          <input
            className="input input-mono h-[30px] flex-1"
            value={input}
            placeholder={t('console.placeholder')}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void run()
              }
            }}
          />
          <button type="button" className="btn btn-primary h-[30px]" onClick={() => void run()} disabled={running || argv.length === 0}>
            {running ? <Spinner size={13} /> : <Icon name="play" size={13} />}
            {running ? t('console.running') : t('console.run')}
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <label className="flex cursor-pointer items-center gap-1.5 text-[11.5px] dim">
            <input
              type="checkbox"
              style={{ accentColor: 'var(--accent)' }}
              checked={interactive}
              onChange={(event) => setInteractive(event.target.checked)}
            />
            {t('console.interactive')}
          </label>
          {preview ? (
            <code className="mono min-w-0 flex-1 truncate faint" title={preview}>
              {preview}
            </code>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <span className="faint mr-1 text-[10.5px] font-semibold uppercase tracking-wider">
            {t('console.examples')}
          </span>
          {EXAMPLES.map((example) => (
            <button
              key={example.args}
              type="button"
              className="badge cursor-pointer transition-transform active:scale-95"
              title={example.args}
              onClick={() => setInput(example.args)}
            >
              <span className="mono max-w-[260px] truncate">{example.args}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
        {error ? (
          <ErrorNotice message={error.message} hint={error.code} onViewLog={() => setView('activity')} />
        ) : null}

        {output ? (
          <pre
            className="log-line whitespace-pre-wrap break-words rounded-lg border p-3"
            style={{ borderColor: 'var(--border)', background: 'var(--panel)' }}
          >
            {output}
          </pre>
        ) : null}

        {!output && !error && !running ? (
          <p className="faint py-6 text-center text-[12px]">
            {t('console.hint')}
          </p>
        ) : null}

        {running ? (
          <div className="flex items-center gap-2 py-6 text-[12px] dim">
            <Spinner size={14} />
            {t('console.running')}
          </div>
        ) : null}
      </div>
    </div>
  )
}
