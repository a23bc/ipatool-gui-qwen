/**
 * Spawns ipatool and turns its output into structured events.
 *
 * Design notes that matter for correctness:
 *
 * - **stdin is closed immediately.** ipatool prompts for a passphrase with
 *   `term.MakeRaw(os.Stdin)`, which *errors* (rather than hangs) when stdin is a
 *   pipe. Closing it guarantees we can never deadlock on a hidden prompt; every
 *   value ipatool might ask for is instead passed as an explicit flag.
 *
 * - **`\r` is a separator, not whitespace.** The download progress bar rewrites
 *   one line with carriage returns, so splitting only on `\n` would hand the UI
 *   a single ever-growing blob. We split on both, and expose the raw chunk too
 *   so the caller can parse progress from it.
 *
 * - **Secrets are scrubbed at the source.** Log lines never reach the renderer
 *   with a password/2FA code/passphrase in them, so nothing sensitive can end up
 *   in the on-screen log, the exported log file or the task history.
 *
 * - **Killing is tree-aware.** On Windows `child.kill()` does not terminate a
 *   process tree, so we shell out to `taskkill /T /F`.
 */

import { spawn, execFile } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { isJsonLine, splitStreamSegments, stripAnsi } from '../shared/ipatool/parse'
import { redactText } from '../shared/redact'
import { childEnvPath, isWindows } from './paths'

export type StreamName = 'stdout' | 'stderr'

export interface RunOptions {
  args: string[]
  /** Working directory for the child process. */
  cwd?: string
  /** Extra environment variables (merged over the defaults). */
  env?: Record<string, string>
  /** Values to scrub from every emitted line. */
  secrets?: string[]
  /** Hard timeout; the process is killed when exceeded. */
  timeoutMs?: number
  /** Raw chunk callback - includes `\r` and ANSI, used for progress parsing. */
  onChunk?: (text: string, stream: StreamName) => void
  /** Cleaned, redacted, one-per-visual-line callback used for the log view. */
  onLine?: (line: string, stream: StreamName, progress: boolean) => void
  /** Emits the fully-formed argv right before spawning (already redacted). */
  onSpawn?: (args: string[]) => void
}

export interface RunOutcome {
  code: number | null
  signal: NodeJS.Signals | null
  /** True when we killed it (user cancel/pause), as opposed to it exiting. */
  killed: boolean
  timedOut: boolean
  /** Redacted, newline-normalised output. */
  stdout: string
  stderr: string
}

export interface RunningProcess {
  promise: Promise<RunOutcome>
  kill(): void
  readonly pid: number | null
}

const DEFAULT_TIMEOUT_MS = 0 // no timeout unless requested

export interface EmitLine {
  text: string
  /**
   * True for progress-bar renders. Decided from the *raw* segment (carriage
   * returns and all) rather than the cleaned text, so a JSON line that merely
   * contains a '%' is never mistaken for progress.
   */
  progress: boolean
}

interface PushResult {
  /** Correctly decoded text for this chunk (safe for multi-byte sequences). */
  text: string
  /** Complete visual lines, ANSI stripped and right-trimmed. */
  lines: EmitLine[]
}

const PROGRESS_TEXT = /downloading|\d(?:\.\d+)?\s?[kMGTPE]?i?B\s*\/\s*s|\[\s*[=>#\-.\s]*\]/

/**
 * Detects a progress-bar render.
 *
 * Segments have already been split on `\r`, so the carriage return itself is no
 * longer available as a signal; detection is text-based instead. Structured JSON
 * is excluded first, which is the important guard - it means a zerolog event
 * that merely contains a '%' or the word "downloading" is never mislabelled and
 * swallowed by the renderer's log collapsing.
 *
 * The patterns match ipatool's actual render ("downloading 21% [==> ] (12/45 MB,
 * 1.2 MB/s)") via three independent features - the description, a rate, or the
 * bar brackets - so it keeps working if any one of them changes. Mis-detection
 * is only ever cosmetic: byte counts come from `onChunk`, not from this flag.
 */
function isProgressRender(cleaned: string): boolean {
  if (isJsonLine(cleaned)) return false
  return PROGRESS_TEXT.test(cleaned)
}

/** Flattens stream output into visual lines, splitting on \r and \n. */
class LineBuffer {
  private buffer = ''
  private readonly decoder = new StringDecoder('utf8')
  private readonly sink: string[] = []

  constructor(private readonly maxSinkLines = 4000) {}

  push(chunk: Buffer): PushResult {
    const text = this.decoder.write(chunk)
    if (text === '') return { text: '', lines: [] }
    const { segments, rest } = splitStreamSegments(this.buffer + text)
    this.buffer = rest
    const lines: EmitLine[] = []
    for (const segment of segments) {
      const trimmed = stripAnsi(segment).replace(/\s+$/, '')
      if (trimmed.trim() === '') continue
      lines.push({ text: trimmed, progress: isProgressRender(trimmed) })
    }
    for (const line of lines) {
      this.sink.push(line.text)
      if (this.sink.length > this.maxSinkLines) this.sink.shift()
    }
    return { text, lines }
  }

  /** Flushes any trailing partial line at process exit. */
  flush(): EmitLine[] {
    const tail = stripAnsi(this.buffer + this.decoder.end()).trim()
    this.buffer = ''
    if (tail === '') return []
    this.sink.push(tail)
    return [{ text: tail, progress: false }]
  }

  get text(): string {
    return this.sink.join('\n')
  }
}

export function startProcess(binary: string, options: RunOptions): RunningProcess {
  const secrets = options.secrets ?? []
  const scrub = (text: string): string => redactText(text, secrets)

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: childEnvPath(),
    // Force UTF-8 and disable any pager-ish behaviour.
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    ...(options.env ?? {})
  }

  // ipatool stores credentials in the first available keyring backend:
  // macOS Keychain, then Linux SecretService, then a per-directory file.
  // The first two are machine-wide single slots, which makes multi-account
  // impossible. On Linux we can opt into real isolation by hiding D-Bus from the
  // child, which makes SecretService unavailable and selects the file backend
  // (already scoped to the profile's state directory). macOS has no such switch;
  // there, switching re-authenticates via stored passwords instead.
  if (process.platform === 'linux') {
    delete env.DBUS_SESSION_BUS_ADDRESS
    delete env.DBUS_SYSTEM_BUS_ADDRESS
  }

  const stdoutBuffer = new LineBuffer()
  const stderrBuffer = new LineBuffer()

  let child: ReturnType<typeof spawn> | null = null
  let killed = false
  let timedOut = false
  let timer: NodeJS.Timeout | null = null

  const emitLines = (lines: EmitLine[], stream: StreamName): void => {
    if (!options.onLine) return
    for (const line of lines) options.onLine(scrub(line.text), stream, line.progress)
  }

  const killTree = (): void => {
    if (!child || child.killed || child.pid === undefined) return
    killed = true
    if (isWindows()) {
      execFile(
        'taskkill',
        ['/pid', String(child.pid), '/T', '/F'],
        { windowsHide: true },
        () => {
          /* best effort - the exit handler covers the rest */
        }
      )
    } else {
      try {
        child.kill('SIGTERM')
      } catch {
        /* ignore */
      }
      // Escalate if it ignores SIGTERM (e.g. stuck in a syscall).
      setTimeout(() => {
        try {
          if (child && !child.killed) child.kill('SIGKILL')
        } catch {
          /* ignore */
        }
      }, 2500).unref?.()
    }
  }

  const promise = new Promise<RunOutcome>((resolve) => {
    child = spawn(binary, options.args, {
      cwd: options.cwd,
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })

    options.onSpawn?.(options.args)

    // Never let ipatool wait on stdin: closing it turns any hidden prompt into
    // an immediate, diagnosable error instead of a hang.
    child.stdin?.on('error', () => {})
    child.stdin?.end()

    child.stdout?.on('data', (chunk: Buffer) => {
      const pushed = stdoutBuffer.push(chunk)
      if (pushed.text !== '') options.onChunk?.(pushed.text, 'stdout')
      emitLines(pushed.lines, 'stdout')
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      const pushed = stderrBuffer.push(chunk)
      if (pushed.text !== '') options.onChunk?.(pushed.text, 'stderr')
      emitLines(pushed.lines, 'stderr')
    })

    child.on('error', (error: Error) => {
      if (timer) clearTimeout(timer)
      // ENOENT here means the binary vanished or is not executable.
      stderrBuffer.push(Buffer.from(`failed to start ipatool: ${error.message}\n`, 'utf8'))
      resolve({
        code: null,
        signal: null,
        killed,
        timedOut,
        stdout: scrub(stdoutBuffer.text),
        stderr: scrub(stderrBuffer.text)
      })
    })

    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer)
      emitLines(stdoutBuffer.flush(), 'stdout')
      emitLines(stderrBuffer.flush(), 'stderr')
      resolve({
        code,
        signal,
        killed,
        timedOut,
        stdout: scrub(stdoutBuffer.text),
        stderr: scrub(stderrBuffer.text)
      })
    })

    const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    if (timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true
        killTree()
      }, timeout)
      timer.unref?.()
    }
  })

  return {
    promise,
    kill: killTree,
    get pid() {
      return child?.pid ?? null
    }
  }
}

/** Convenience wrapper: run to completion and return the outcome. */
export async function run(binary: string, options: RunOptions): Promise<RunOutcome> {
  return startProcess(binary, options).promise
}
