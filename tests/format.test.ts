import { describe, expect, it } from 'vitest'
import {
  MovingAverage,
  clampPercent,
  formatBytes,
  formatDuration,
  formatEta,
  formatRelativeTime,
  formatSpeed,
  quoteCommand
} from '@shared/format'

describe('formatBytes', () => {
  it('formats binary units', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(1024 ** 2)).toBe('1.0 MB')
    expect(formatBytes(1024 ** 3 * 3)).toBe('3.0 GB')
  })

  it('drops the fraction for large values so columns do not jitter', () => {
    expect(formatBytes(150 * 1024 ** 2)).toBe('150 MB')
  })

  it('handles null/undefined/NaN gracefully', () => {
    expect(formatBytes(null)).toBe('—')
    expect(formatBytes(undefined)).toBe('—')
    expect(formatBytes(Number.NaN)).toBe('—')
    expect(formatBytes(-5)).toBe('—')
  })
})

describe('formatSpeed', () => {
  it('appends a per-second suffix', () => {
    expect(formatSpeed(1024 ** 2)).toBe('1.0 MB/s')
  })

  it('is a dash when unknown', () => {
    expect(formatSpeed(0)).toBe('—')
    expect(formatSpeed(null)).toBe('—')
  })
})

describe('formatDuration', () => {
  it('scales the format to the magnitude', () => {
    expect(formatDuration(0)).toBe('0s')
    expect(formatDuration(45)).toBe('45s')
    expect(formatDuration(75)).toBe('1:15')
    expect(formatDuration(3600 + 61)).toBe('1:01:01')
  })

  it('is a dash when unknown', () => {
    expect(formatDuration(null)).toBe('—')
    expect(formatDuration(-1)).toBe('—')
  })
})

describe('formatEta', () => {
  it('caps absurd estimates', () => {
    expect(formatEta(999_999)).toBe('>1d')
  })
})

describe('formatRelativeTime', () => {
  const now = Date.UTC(2026, 0, 1, 12, 0, 0)
  it('describes recent events in words', () => {
    expect(formatRelativeTime(now - 1000, now)).toBe('just now')
    expect(formatRelativeTime(now - 30_000, now)).toBe('30s ago')
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe('5m ago')
    expect(formatRelativeTime(now - 3 * 3600_000, now)).toBe('3h ago')
    expect(formatRelativeTime(now - 4 * 86_400_000, now)).toBe('4d ago')
  })

  it('falls back to an absolute time for old entries and future timestamps', () => {
    expect(formatRelativeTime(now - 400 * 86_400_000, now)).not.toBe('—')
    expect(formatRelativeTime(now + 60_000, now)).not.toBe('—')
    expect(formatRelativeTime(null, now)).toBe('—')
  })
})

describe('clampPercent', () => {
  it('clamps and guards', () => {
    expect(clampPercent(50)).toBe(50)
    expect(clampPercent(-5)).toBe(0)
    expect(clampPercent(150)).toBe(100)
    expect(clampPercent(null)).toBe(0)
    expect(clampPercent(Number.NaN)).toBe(0)
  })
})

describe('quoteCommand', () => {
  it('quotes only what needs quoting', () => {
    expect(quoteCommand(['search', 'telegram', '-l', '10'])).toBe('search telegram -l 10')
    expect(quoteCommand(['search', 'shadow rocket'])).toBe('search "shadow rocket"')
  })

  it('escapes shell metacharacters inside quotes', () => {
    expect(quoteCommand(['-e', 'a`b$c'])).toBe('-e "a\\`b\\$c"')
  })
})

describe('MovingAverage', () => {
  it('seeds with the first sample', () => {
    const ma = new MovingAverage(0.3)
    expect(ma.push(100)).toBe(100)
  })

  it('smooths spikes instead of following them', () => {
    const ma = new MovingAverage(0.3)
    ma.push(1000)
    const after = ma.push(0)
    expect(after).toBeGreaterThan(0)
    expect(after).toBeLessThan(1000)
  })

  it('resets', () => {
    const ma = new MovingAverage()
    ma.push(500)
    ma.reset()
    expect(ma.current).toBe(0)
  })
})
