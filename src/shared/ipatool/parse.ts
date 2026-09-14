/**
 * Parsing helpers for everything ipatool writes to stdout/stderr.
 *
 * Two very different streams have to be understood:
 *
 *  1. **Structured output.** With `--format json` ipatool uses zerolog and emits
 *     one JSON object per line on stdout, e.g.
 *       {"level":"info","message":"search","count":5,"apps":[{...}]}
 *       {"level":"error","error":"...","success":false}
 *     Prompts and human text go to stderr, so stdout stays valid JSON.
 *
 *  2. **The download progress bar.** `download` is the one command we run
 *     *interactively*, because progressbar/v3 is only constructed in that mode.
 *     With ipatool's exact option set (ShowBytes + ShowCount + FullWidth +
 *     Spinner + ClearOnFinish) and a known content length, progressbar renders:
 *
 *         \rdownloading  21% [=====>        ] (12/45 MB, 1.2 MB/s) \r
 *
 *     Three details matter and are easy to get wrong:
 *       - units are **decimal** (base 1000) unless IEC is requested, and the
 *         suffix carries a leading space (" B", " kB", " MB", ...);
 *       - when current and total share a suffix it collapses to `12/45 MB`
 *         (one suffix for both), otherwise `900 kB/45 MB`;
 *       - the transfer rate sits in the *same* parentheses, so a naive
 *         "first two sizes" scan reads the rate as the total.
 *
 *     The parser below handles all of that, and is still tolerant enough to
 *     survive layout changes between progressbar releases.
 *
 * Everything in here is pure and unit-tested.
 */

// Matches CSI/OSC escape sequences emitted by progressbar (cursor moves, erase
// line, colour codes). Control characters are unavoidable here.
const ANSI_RE = /[\u001b\u009b][[()#;?]*(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]/g

/** Removes ANSI/VT escape sequences so progress renders can be read as text. */
export function stripAnsi(input: string): string {
  return input.replace(ANSI_RE, '')
}

export interface ZerologEvent {
  level?: string
  time?: string | number
  message?: string
  error?: string
  success?: boolean
  [key: string]: unknown
}

/** True when a line looks like a zerolog JSON event. */
export function isJsonLine(line: string): boolean {
  const t = line.trimStart()
  return t.startsWith('{') && t.endsWith('}')
}

/** Parses a zerolog line, returning null when it is not JSON. */
export function parseJsonLine(line: string): ZerologEvent | null {
  if (!isJsonLine(line)) return null
  try {
    const parsed = JSON.parse(line) as unknown
    if (parsed && typeof parsed === 'object') return parsed as ZerologEvent
    return null
  } catch {
    return null
  }
}

/**
 * Splits a raw stream chunk into logical segments.
 *
 * progressbar overwrites its line with `\r` (and clears it with a run of
 * spaces), so `\r` is treated as a segment separator just like `\n`. Partial
 * trailing data is returned so the caller can prepend it to the next chunk.
 */
export interface SplitResult {
  /** Complete segments, in order. */
  segments: string[]
  /** Leftover text without a terminator yet. */
  rest: string
}

export function splitStreamSegments(buffer: string): SplitResult {
  const segments: string[] = []
  let current = ''
  for (let i = 0; i < buffer.length; i += 1) {
    const ch = buffer[i]
    if (ch === '\n' || ch === '\r') {
      segments.push(current)
      current = ''
      // Swallow a CRLF pair as a single separator.
      if (ch === '\r' && buffer[i + 1] === '\n') i += 1
    } else {
      current += ch
    }
  }
  return { segments, rest: current }
}

/* ------------------------------------------------------------------ *
 * Progress parsing
 * ------------------------------------------------------------------ */

/** progressbar's unit suffixes, decimal and IEC. */
const UNIT = String.raw`(?:[kMGTPE]i?B|B)`
const NUM = String.raw`\d+(?:[.,]\d+)?`

const RATE_RE = new RegExp(`(${NUM})\\s*(${UNIT})\\s*/\\s*s(?![A-Za-z])`, 'i')
/** "12/45 MB" - both numbers share one suffix. */
const SHARED_UNIT_RE = new RegExp(`(${NUM})\\s*/\\s*(${NUM})\\s*(${UNIT})(?![A-Za-z])`, 'i')
/** "900 kB/45 MB" - each number carries its own suffix. */
const OWN_UNIT_RE = new RegExp(`(${NUM})\\s*(${UNIT})\\s*/\\s*(${NUM})\\s*(${UNIT})(?![A-Za-z])`, 'i')
/** "(12345678/45678901)" - raw byte counters when humanising is off. */
const RAW_COUNTS_RE = /\((\d[\d,\s]*)\s*\/\s*(\d[\d,\s]*)\)/
/**
 * A lone human size, e.g. "(12 MB, ...)". progressbar renders this when the
 * total length is unknown (spinner mode), which happens before ipatool calls
 * ChangeMax64 - and stays that way if the server omits Content-Length.
 */
const LONE_SIZE_RE = new RegExp(`(${NUM})\\s*(${UNIT})(?![A-Za-z])`, 'i')
const PERCENT_RE = /(\d{1,3}(?:\.\d+)?)\s*%/

const DECIMAL_ORDER = ['b', 'kb', 'mb', 'gb', 'tb', 'pb', 'eb']

/** Converts a progressbar suffix into a byte multiplier (base 1000 or 1024). */
export function unitMultiplier(unit: string): number {
  const lower = unit.toLowerCase()
  const iec = lower.includes('i')
  const base = iec ? 1024 : 1000
  const key = iec ? lower.replace('i', '') : lower
  const index = DECIMAL_ORDER.indexOf(key)
  if (index <= 0) return 1
  return base ** index
}

function toNumber(raw: string): number | null {
  // progressbar never emits thousands separators, but "12,5" style decimals
  // appear in some locales; normalise both.
  const cleaned = raw.replace(/\s/g, '').replace(',', '.')
  const n = Number.parseFloat(cleaned)
  return Number.isFinite(n) ? n : null
}

export interface ProgressSample {
  received: number | null
  total: number | null
  percent: number | null
  /** Bytes/second as reported by progressbar itself, when present. */
  speed: number | null
}

/**
 * Extracts a progress sample from one rendered progress-bar segment.
 *
 * Order of operations matters: the rate is removed *first* so it can never be
 * mistaken for the total, then the collapsed `a/b UNIT` form is tried before the
 * `a UNIT/b UNIT` form.
 */
export function parseProgressSegment(rawSegment: string): ProgressSample | null {
  const segment = stripAnsi(rawSegment)
  if (segment.trim() === '') return null

  let speed: number | null = null
  let working = segment

  const rateMatch = RATE_RE.exec(working)
  if (rateMatch) {
    const value = toNumber(rateMatch[1])
    if (value !== null) speed = Math.round(value * unitMultiplier(rateMatch[2]))
    // Strip it so the remaining sizes are unambiguous.
    working = working.slice(0, rateMatch.index) + ' ' + working.slice(rateMatch.index + rateMatch[0].length)
  }

  let received: number | null = null
  let total: number | null = null

  const shared = SHARED_UNIT_RE.exec(working)
  if (shared) {
    const a = toNumber(shared[1])
    const b = toNumber(shared[2])
    const mult = unitMultiplier(shared[3])
    if (a !== null && b !== null) {
      received = Math.round(a * mult)
      total = Math.round(b * mult)
    }
  } else {
    const own = OWN_UNIT_RE.exec(working)
    if (own) {
      const a = toNumber(own[1])
      const b = toNumber(own[3])
      if (a !== null && b !== null) {
        received = Math.round(a * unitMultiplier(own[2]))
        total = Math.round(b * unitMultiplier(own[4]))
      }
    } else {
      const raw = RAW_COUNTS_RE.exec(working)
      if (raw) {
        received = toNumber(raw[1])
        total = toNumber(raw[2])
      } else {
        const lone = LONE_SIZE_RE.exec(working)
        if (lone) {
          const value = toNumber(lone[1])
          if (value !== null) received = Math.round(value * unitMultiplier(lone[2]))
        }
      }
    }
  }

  const percentMatch = PERCENT_RE.exec(segment)
  let percent: number | null = null
  if (percentMatch) {
    const p = toNumber(percentMatch[1])
    if (p !== null && p >= 0 && p <= 100) percent = p
  }

  // Fill in whatever is missing, when it can be derived.
  if (percent === null && received !== null && total !== null && total > 0) {
    percent = (received / total) * 100
  }
  if (total === null && received !== null && percent !== null && percent > 0) {
    total = Math.round((received / percent) * 100)
  }

  if (received === null && total === null && percent === null && speed === null) return null
  return { received, total, percent, speed }
}

/**
 * Scans a whole chunk (which may contain many `\r`-separated renders plus the
 * space-only clearing runs progressbar emits) and returns the newest sample.
 */
export function parseProgressChunk(chunk: string): ProgressSample | null {
  const { segments, rest } = splitStreamSegments(chunk)
  let latest: ProgressSample | null = null
  for (const segment of segments) {
    const sample = parseProgressSegment(segment)
    if (sample) latest = sample
  }
  const tail = parseProgressSegment(rest)
  if (tail) latest = tail
  return latest
}

/** Merges a newer sample over an older one, keeping previously known fields. */
export function mergeProgress(base: ProgressSample | null, next: ProgressSample | null): ProgressSample | null {
  if (!next) return base
  if (!base) return next
  return {
    received: next.received ?? base.received,
    total: next.total ?? base.total,
    percent: next.percent ?? base.percent,
    speed: next.speed ?? base.speed
  }
}

const RATE_ONLY_RE = new RegExp(`${UNIT}\\s*/\\s*s(?![A-Za-z])`, 'i')

/** True when a chunk is progress-bar noise rather than meaningful output. */
export function looksLikeProgress(chunk: string): boolean {
  const cleaned = stripAnsi(chunk)
  if (cleaned.trim() === '') return true
  return /downloading/i.test(cleaned) || RATE_ONLY_RE.test(cleaned)
}

/* ------------------------------------------------------------------ *
 * Outcome extraction
 * ------------------------------------------------------------------ */

export interface CommandOutcome {
  /** All zerolog events seen, in order. */
  events: ZerologEvent[]
  /** The last event carrying `success: true`, if any. */
  successEvent: ZerologEvent | null
  /** The last event carrying `level: "error"` or an `error` field. */
  errorEvent: ZerologEvent | null
  /** Non-JSON lines (prompts, human text), in order. */
  textLines: string[]
}

export function buildOutcome(events: ZerologEvent[], textLines: string[]): CommandOutcome {
  let successEvent: ZerologEvent | null = null
  let errorEvent: ZerologEvent | null = null
  for (const event of events) {
    if (event.success === true) successEvent = event
    if (event.level === 'error' || typeof event.error === 'string') errorEvent = event
  }
  return { events, successEvent, errorEvent, textLines }
}

/** Reads the `apps` array out of a search / list-purchases success event. */
export function readApps(event: ZerologEvent | null): unknown[] {
  if (!event) return []
  const apps = event.apps
  return Array.isArray(apps) ? apps : []
}

export function readNumber(event: ZerologEvent | null, key: string): number | null {
  if (!event) return null
  const value = event[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function readString(event: ZerologEvent | null, key: string): string {
  if (!event) return ''
  const value = event[key]
  return typeof value === 'string' ? value : ''
}

export function readStringArray(event: ZerologEvent | null, key: string): string[] {
  if (!event) return []
  const value = event[key]
  if (!Array.isArray(value)) return []
  return value.map((v) => String(v)).filter((v) => v !== '')
}

/**
 * Parses the `<hash>  <filename>` content of ipatool's published
 * `.sha256sum` sidecar files.
 */
export function parseSha256Sum(text: string): { hash: string; file: string } | null {
  const line = text.split(/\r?\n/).find((l) => l.trim().length > 0)
  if (!line) return null
  const parts = line.trim().split(/\s+/)
  const hash = (parts[0] ?? '').replace(/^\*/, '').toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(hash)) return null
  return { hash, file: parts.slice(1).join(' ').replace(/^\*/, '') }
}

/** Parses `ipatool version 2.6.0` / bare `2.6.0` output of `ipatool --version`. */
export function parseVersion(text: string): string | null {
  const match = text.match(/(\d+\.\d+\.\d+[-\w.]*)/)
  return match ? match[1] : null
}
