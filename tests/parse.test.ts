import { describe, expect, it } from 'vitest'
import {
  buildOutcome,
  isJsonLine,
  looksLikeProgress,
  mergeProgress,
  parseJsonLine,
  parseProgressChunk,
  parseProgressSegment,
  parseSha256Sum,
  parseVersion,
  readApps,
  readNumber,
  readStringArray,
  splitStreamSegments,
  stripAnsi,
  unitMultiplier
} from '@shared/ipatool/parse'

/**
 * Real renders produced by progressbar/v3 with ipatool's exact option set
 * (ShowBytes + ShowCount + FullWidth + ClearOnFinish + throttle 65ms) and a
 * known content length. The leading/trailing `\r` and the space-only clearing
 * run are reproduced verbatim because that is what actually arrives on the pipe.
 */
const RENDER_SAME_UNIT = '\rdownloading  21% [======>           ] (12/45 MB, 1.2 MB/s) \r'
const RENDER_MIXED_UNIT = '\rdownloading   2% [>                   ] (900 kB/45 MB, 450 kB/s) \r'
const RENDER_DECIMALS = '\rdownloading   3% [=>                  ] (1.5/45.6 MB, 2.3 MB/s) \r'
const RENDER_DONE = '\rdownloading 100% [====================] (45/45 MB, 3.1 MB/s) \r'
const RENDER_BLANK = '\rdownloading   0% [                    ] (0/1 B) \r'
const CLEAR_RUN = `\r${' '.repeat(78)}\r`

describe('stripAnsi', () => {
  it('removes cursor and erase sequences', () => {
    expect(stripAnsi('\u001b[K\rdownloading 21%\u001b[0m')).toBe('\rdownloading 21%')
  })

  it('leaves plain text untouched', () => {
    expect(stripAnsi('hello world')).toBe('hello world')
  })
})

describe('splitStreamSegments', () => {
  it('treats \\r as a separator like \\n', () => {
    const { segments, rest } = splitStreamSegments('a\rb\nc')
    expect(segments).toEqual(['a', 'b'])
    expect(rest).toBe('c')
  })

  it('collapses CRLF into one separator', () => {
    expect(splitStreamSegments('a\r\nb').segments).toEqual(['a'])
  })

  it('keeps empty clearing runs as segments so callers can skip them', () => {
    const { segments } = splitStreamSegments(`\r${' '.repeat(10)}\rreal`)
    expect(segments).toEqual(['', ' '.repeat(10)])
  })
})

describe('unitMultiplier', () => {
  it('uses decimal units like progressbar does by default', () => {
    expect(unitMultiplier('B')).toBe(1)
    expect(unitMultiplier('kB')).toBe(1000)
    expect(unitMultiplier('MB')).toBe(1_000_000)
    expect(unitMultiplier('GB')).toBe(1_000_000_000)
  })

  it('supports IEC units when they appear', () => {
    expect(unitMultiplier('KiB')).toBe(1024)
    expect(unitMultiplier('MiB')).toBe(1024 ** 2)
  })
})

describe('parseProgressSegment', () => {
  it('reads the collapsed "12/45 MB" form and does NOT mistake the rate for the total', () => {
    const sample = parseProgressSegment(RENDER_SAME_UNIT)
    expect(sample).not.toBeNull()
    expect(sample!.received).toBe(12_000_000)
    expect(sample!.total).toBe(45_000_000)
    expect(sample!.percent).toBe(21)
    expect(sample!.speed).toBe(1_200_000)
  })

  it('reads the "900 kB/45 MB" mixed-suffix form', () => {
    const sample = parseProgressSegment(RENDER_MIXED_UNIT)
    expect(sample!.received).toBe(900_000)
    expect(sample!.total).toBe(45_000_000)
    expect(sample!.percent).toBe(2)
    expect(sample!.speed).toBe(450_000)
  })

  it('handles fractional values on both sides', () => {
    const sample = parseProgressSegment(RENDER_DECIMALS)
    expect(sample!.received).toBe(1_500_000)
    expect(sample!.total).toBe(45_600_000)
  })

  it('handles completion', () => {
    const sample = parseProgressSegment(RENDER_DONE)
    expect(sample!.percent).toBe(100)
    expect(sample!.received).toBe(sample!.total)
  })

  it('survives the blank-state render before ChangeMax64 is called', () => {
    const sample = parseProgressSegment(RENDER_BLANK)
    expect(sample!.received).toBe(0)
    expect(sample!.total).toBe(1)
    expect(sample!.percent).toBe(0)
  })

  it('derives percent from bytes when progressbar omits it', () => {
    const sample = parseProgressSegment('downloading (50/200 MB)')
    expect(sample!.percent).toBeCloseTo(25, 5)
  })

  it('derives total from percent when only the current size is shown', () => {
    const sample = parseProgressSegment('downloading 25% 10 MB')
    expect(sample!.received).toBe(10_000_000)
    expect(sample!.total).toBe(40_000_000)
  })

  it('parses raw byte counters when humanising is disabled', () => {
    const sample = parseProgressSegment('downloading (12345678/45678901)')
    expect(sample!.received).toBe(12_345_678)
    expect(sample!.total).toBe(45_678_901)
  })

  it('returns null for a space-only clearing run', () => {
    expect(parseProgressSegment(' '.repeat(78))).toBeNull()
    expect(parseProgressSegment('')).toBeNull()
  })

  it('ignores the description text', () => {
    const sample = parseProgressSegment('downloading  50% [==========]')
    expect(sample!.percent).toBe(50)
    expect(sample!.received).toBeNull()
  })

  it('reads spinner mode where the total length is unknown', () => {
    // progressbar renders only the current size when ignoreLength is set,
    // which is what ipatool hits before ChangeMax64 is called.
    const sample = parseProgressSegment('\r⠋ downloading (12 MB, 900 kB/s) \r')
    expect(sample!.received).toBe(12_000_000)
    expect(sample!.total).toBeNull()
    expect(sample!.speed).toBe(900_000)
  })
})

describe('parseProgressChunk', () => {
  it('returns the newest sample from a chunk containing many renders', () => {
    const chunk =
      CLEAR_RUN +
      '\rdownloading   5% [=>                  ] (2/45 MB, 900 kB/s) \r' +
      CLEAR_RUN +
      '\rdownloading  60% [============>       ] (27/45 MB, 1.1 MB/s) \r'
    const sample = parseProgressChunk(chunk)
    expect(sample!.percent).toBe(60)
    expect(sample!.received).toBe(27_000_000)
  })

  it('skips clearing runs and still finds the render', () => {
    const sample = parseProgressChunk(CLEAR_RUN + RENDER_SAME_UNIT + CLEAR_RUN)
    expect(sample!.total).toBe(45_000_000)
  })

  it('returns null when the chunk carries no progress information', () => {
    expect(parseProgressChunk('{"level":"info","message":"downloading"}')).toBeNull()
  })
})

describe('mergeProgress', () => {
  it('keeps previously known fields when the new sample is partial', () => {
    const merged = mergeProgress(
      { received: 1000, total: 4000, percent: 25, speed: 500 },
      { received: 2000, total: null, percent: null, speed: null }
    )
    expect(merged).toEqual({ received: 2000, total: 4000, percent: 25, speed: 500 })
  })

  it('overrides a bogus blank-state total once the real one arrives', () => {
    const merged = mergeProgress(
      { received: 0, total: 1, percent: 0, speed: null },
      { received: 12_000_000, total: 45_000_000, percent: 21, speed: 1_200_000 }
    )
    expect(merged!.total).toBe(45_000_000)
  })
})

describe('looksLikeProgress', () => {
  it('detects progress renders and clearing runs', () => {
    expect(looksLikeProgress(RENDER_SAME_UNIT)).toBe(true)
    expect(looksLikeProgress(CLEAR_RUN)).toBe(true)
  })

  it('does not swallow structured JSON', () => {
    expect(looksLikeProgress('{"level":"info","message":"search"}')).toBe(false)
  })
})

describe('zerolog parsing', () => {
  it('detects and parses JSON lines', () => {
    const line = '{"level":"info","message":"search","count":2,"apps":[{"id":1}]}'
    expect(isJsonLine(line)).toBe(true)
    const event = parseJsonLine(line)
    expect(event!.message).toBe('search')
    expect(readApps(event)).toHaveLength(1)
  })

  it('rejects non-JSON lines', () => {
    expect(isJsonLine('enter email: ')).toBe(false)
    expect(parseJsonLine('not json')).toBeNull()
    expect(parseJsonLine('{"broken":')).toBeNull()
  })

  it('builds an outcome picking the success and error events', () => {
    const events = [
      parseJsonLine('{"level":"debug","message":"preparing"}')!,
      parseJsonLine('{"level":"info","message":"search","success":true,"count":1,"apps":[]}')!
    ]
    const outcome = buildOutcome(events, ['some prompt'])
    expect(outcome.successEvent!.message).toBe('search')
    expect(outcome.errorEvent).toBeNull()
    expect(outcome.textLines).toEqual(['some prompt'])
  })

  it('captures error events', () => {
    const events = [parseJsonLine('{"level":"error","error":"license is required","success":false}')!]
    const outcome = buildOutcome(events, [])
    expect(outcome.successEvent).toBeNull()
    expect(outcome.errorEvent!.error).toBe('license is required')
  })

  it('exposes the last info event as payload fallback', () => {
    // Upstream `search` / `list-purchases` never stamp success:true, so the
    // payload must be recoverable from the last info-level event.
    const events = [
      parseJsonLine(
        '{"level":"info","count":2,"apps":[{"id":1,"bundleID":"com.a","name":"A","version":"1","price":0},{"id":2,"bundleID":"com.b","name":"B","version":"2","price":0}]}'
      )!
    ]
    const outcome = buildOutcome(events, [])
    expect(outcome.successEvent).toBeNull()
    expect(outcome.errorEvent).toBeNull()
    expect(outcome.lastInfoEvent).not.toBeNull()
    expect(readApps(outcome.lastInfoEvent)).toHaveLength(2)
    expect(readNumber(outcome.lastInfoEvent, 'count')).toBe(2)
  })

  it('keeps lastInfoEvent null when only errors were emitted', () => {
    const outcome = buildOutcome([parseJsonLine('{"level":"error","error":"boom"}')!], [])
    expect(outcome.lastInfoEvent).toBeNull()
  })

  it('reads string arrays such as externalVersionIdentifiers', () => {
    const event = parseJsonLine(
      '{"level":"info","message":"list-versions","externalVersionIdentifiers":["8639","8640"],"bundleID":"com.x","success":true}'
    )
    expect(readStringArray(event, 'externalVersionIdentifiers')).toEqual(['8639', '8640'])
  })
})

describe('parseSha256Sum', () => {
  it('parses the published sidecar format', () => {
    const text = 'a8bbd8a5a6515d0b858c6cfe6c2baf70943a4235b7fa65d5bd01a42a7d5bedbb  ipatool-2.6.0-linux-amd64.tar.gz\n'
    const parsed = parseSha256Sum(text)
    expect(parsed!.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(parsed!.file).toBe('ipatool-2.6.0-linux-amd64.tar.gz')
  })

  it('handles the BSD "*binary" marker', () => {
    const parsed = parseSha256Sum(`${'a'.repeat(64)} *file.tar.gz`)
    expect(parsed!.file).toBe('file.tar.gz')
  })

  it('rejects malformed input', () => {
    expect(parseSha256Sum('')).toBeNull()
    expect(parseSha256Sum('nothex  file')).toBeNull()
  })
})

describe('parseVersion', () => {
  it('extracts a semver from --version output', () => {
    expect(parseVersion('ipatool version 2.6.0\n')).toBe('2.6.0')
    expect(parseVersion('2.6.0')).toBe('2.6.0')
    expect(parseVersion('ipatool version 2.7.0-rc1')).toBe('2.7.0-rc1')
  })

  it('returns null when nothing looks like a version', () => {
    expect(parseVersion('command not found')).toBeNull()
  })
})
