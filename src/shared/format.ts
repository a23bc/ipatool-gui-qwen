/**
 * Formatting helpers shared by both processes. Isomorphic on purpose: the main
 * process uses them for notifications and log summaries, the renderer for the
 * UI, so numbers always look identical.
 */

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const

/** Formats a byte count using binary units, e.g. 1536 -> "1.5 KB". */
export function formatBytes(bytes: number | null | undefined, fractionDigits = 1): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes === 0) return '0 B'
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), BYTE_UNITS.length - 1)
  const value = bytes / 1024 ** exponent
  const digits = exponent === 0 ? 0 : value >= 100 ? 0 : fractionDigits
  return `${value.toFixed(digits)} ${BYTE_UNITS[exponent]}`
}

/** Compact byte formatting for tight table cells. */
export function formatBytesShort(bytes: number | null | undefined): string {
  return formatBytes(bytes, 1)
}

/** Formats a transfer rate. */
export function formatSpeed(bytesPerSecond: number | null | undefined): string {
  if (!bytesPerSecond || !Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '—'
  return `${formatBytes(bytesPerSecond)}/s`
}

/** Formats a duration in seconds as h:mm:ss / m:ss / Ns. */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '—'
  const total = Math.round(seconds)
  if (total < 60) return `${total}s`
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  const pad = (n: number): string => String(n).padStart(2, '0')
  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(secs)}`
  return `${minutes}:${pad(secs)}`
}

export function formatEta(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '—'
  if (seconds > 86_400) return '>1d'
  return formatDuration(seconds)
}

/** "3 min ago" style relative time; falls back to a locale string. */
export function formatRelativeTime(timestamp: number | null | undefined, now = Date.now(), locale = 'en-US'): string {
  if (!timestamp) return '—'
  const delta = now - timestamp
  if (delta < 0) return formatClockTime(timestamp, locale)
  const seconds = Math.round(delta / 1000)
  if (seconds < 5) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`
  return formatClockTime(timestamp, locale)
}

export function formatClockTime(timestamp: number, locale = 'en-US'): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date(timestamp))
  } catch {
    return new Date(timestamp).toISOString()
  }
}

export function formatDateOnly(iso: string | null | undefined): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** Clamps a percentage to 0..100 with one decimal. */
export function clampPercent(value: number | null | undefined): number {
  if (value === null || value === undefined || !Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, value))
}

/** Renders an argv array as a shell-ish string, quoting where needed. */
export function quoteCommand(args: string[]): string {
  return args
    .map((arg) => (/^[\w./:@=,+-]+$/.test(arg) ? arg : `"${arg.replace(/(["\\$`])/g, '\\$1')}"`))
    .join(' ')
}

/**
 * Exponentially-weighted moving average used to smooth download speed so the
 * UI does not flicker between bursts.
 */
export class MovingAverage {
  private value = 0
  private initialised = false

  constructor(private readonly alpha = 0.3) {}

  push(sample: number): number {
    if (!this.initialised) {
      this.value = sample
      this.initialised = true
    } else {
      this.value = this.alpha * sample + (1 - this.alpha) * this.value
    }
    return this.value
  }

  get current(): number {
    return this.initialised ? this.value : 0
  }

  reset(): void {
    this.value = 0
    this.initialised = false
  }
}
