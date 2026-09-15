/**
 * runner.ts unit tests: LineBuffer and progress detection.
 *
 * Both are pure logic (no child processes spawned here); `electron` is mocked
 * because runner -> paths imports it at module load.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/ipatool-runner-test', isReady: () => false }
}))

import { isProgressRender, LineBuffer } from '@main/runner'

function chunk(text: string): Buffer {
  return Buffer.from(text, 'utf8')
}

describe('LineBuffer', () => {
  it('emits complete newline-terminated lines', () => {
    const buffer = new LineBuffer()
    const pushed = buffer.push(chunk('first\nsecond\n'))
    expect(pushed.lines.map((l) => l.text)).toEqual(['first', 'second'])
    expect(buffer.text).toBe('first\nsecond')
  })

  it('holds back an incomplete trailing line until it terminates', () => {
    const buffer = new LineBuffer()
    expect(buffer.push(chunk('partial')).lines).toEqual([])
    const rest = buffer.push(chunk(' line\n'))
    expect(rest.lines.map((l) => l.text)).toEqual(['partial line'])
  })

  it('splits progress renders on carriage returns', () => {
    const buffer = new LineBuffer()
    const pushed = buffer.push(chunk('downloading 10% [=>  ]\rdownloading 50% [=====>  ]\r'))
    const texts = pushed.lines.map((l) => l.text)
    expect(texts).toEqual(['downloading 10% [=>  ]', 'downloading 50% [=====>  ]'])
    expect(pushed.lines.every((l) => l.progress)).toBe(true)
  })

  it('strips ANSI escapes and trailing whitespace', () => {
    const buffer = new LineBuffer()
    const pushed = buffer.push(chunk('\u001b[32mcoloured\u001b[0m text   \n'))
    expect(pushed.lines[0]?.text).toBe('coloured text')
  })

  it('drops empty / whitespace-only segments', () => {
    const buffer = new LineBuffer()
    expect(buffer.push(chunk('\n\n   \n')).lines).toEqual([])
  })

  it('decodes multi-byte UTF-8 split across chunks', () => {
    const buffer = new LineBuffer()
    const bytes = Buffer.from('下载完成\n', 'utf8')
    // Split in the middle of the first 3-byte character.
    buffer.push(bytes.subarray(0, 4))
    const pushed = buffer.push(bytes.subarray(4))
    expect(pushed.lines[0]?.text).toBe('下载完成')
  })

  it('flags JSON lines as non-progress even when they mention downloading', () => {
    const buffer = new LineBuffer()
    const pushed = buffer.push(chunk('{"level":"info","message":"downloading app","percent":21}\n'))
    expect(pushed.lines[0]?.progress).toBe(false)
  })

  it('flush() returns the trailing partial line exactly once', () => {
    const buffer = new LineBuffer()
    buffer.push(chunk('tail without newline'))
    expect(buffer.flush().map((l) => l.text)).toEqual(['tail without newline'])
    expect(buffer.flush()).toEqual([])
  })

  it('bounds the accumulated sink', () => {
    const buffer = new LineBuffer(3)
    buffer.push(chunk('a\nb\nc\nd\ne\n'))
    expect(buffer.text.split('\n')).toEqual(['c', 'd', 'e'])
  })
})

describe('isProgressRender', () => {
  it('recognises ipatool progress-bar renders', () => {
    expect(isProgressRender('downloading 21% [===>    ] (12/45 MB, 1.2 MB/s)')).toBe(true)
    expect(isProgressRender('  4.2 MiB/s')).toBe(true)
    expect(isProgressRender('[======>            ]')).toBe(true)
  })

  it('never mistakes zerolog JSON for progress', () => {
    expect(isProgressRender('{"level":"info","message":"downloading 50%"}')).toBe(false)
  })

  it('returns false for ordinary text', () => {
    expect(isProgressRender('searching for "telegram"')).toBe(false)
    expect(isProgressRender('')).toBe(false)
  })
})
