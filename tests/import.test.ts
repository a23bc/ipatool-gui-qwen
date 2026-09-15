import { describe, expect, it } from 'vitest'
import { parseEntry, parseImportList } from '@shared/import'

describe('parseEntry', () => {
  it('accepts a bare bundle identifier', () => {
    expect(parseEntry('com.apple.mobilesafari')).toMatchObject({ bundleID: 'com.apple.mobilesafari' })
  })

  it('accepts a bare numeric track id', () => {
    expect(parseEntry('686449807')).toMatchObject({ appId: 686449807 })
  })

  it('extracts the id from an App Store URL', () => {
    expect(parseEntry('https://apps.apple.com/us/app/telegram/id686449807')).toMatchObject({
      appId: 686449807
    })
  })

  it('parses pipe-delimited rows', () => {
    const entry = parseEntry('686449807 | Telegram | 10.5.1')
    expect(entry).toMatchObject({ appId: 686449807, name: 'Telegram', version: '10.5.1' })
  })

  it('parses key/value rows including platform aliases', () => {
    const entry = parseEntry('id: 686449807, name: Telegram, platform: ios')
    expect(entry).toMatchObject({ appId: 686449807, name: 'Telegram', platform: 'iphone' })
  })

  it('maps platform aliases onto ipatool tokens', () => {
    // A bundle id needs two or more dot-separated labels, so com.example.x is a
    // realistic "bare id plus named fields" line.
    expect(parseEntry('com.example.x, platform: tvos')?.platform).toBe('appletv')
    expect(parseEntry('com.example.x, platform: visionpro')?.platform).toBe('visionos')
    expect(parseEntry('com.example.x, platform: mac')?.platform).toBe('macos')
    expect(parseEntry('com.example.x, platform: nonsense')?.platform).toBeUndefined()
  })

  it('combines a bare id with named fields in one line', () => {
    const entry = parseEntry('com.example.x, platform: ios, version_id: 86394041')
    expect(entry).toMatchObject({
      bundleID: 'com.example.x',
      platform: 'iphone',
      externalVersionID: '86394041'
    })
  })

  it('ignores comments and blanks', () => {
    expect(parseEntry('# a comment')).toBeNull()
    expect(parseEntry('// another')).toBeNull()
    expect(parseEntry('   ')).toBeNull()
    expect(parseEntry('')).toBeNull()
  })

  it('rejects unrecognisable lines', () => {
    expect(parseEntry('not an app at all')).toBeNull()
    expect(parseEntry('https://example.com/no-id-here')).toBeNull()
  })

  it('keeps the original line for the UI', () => {
    expect(parseEntry('com.x')?.source).toBe('com.x')
  })
})

describe('parseImportList', () => {
  it('parses a whole document and drops duplicates', () => {
    const text = [
      'com.apple.mobilesafari',
      'com.apple.mobilesafari',
      '686449807',
      '',
      '# comment',
      'https://apps.apple.com/app/id686449807'
    ].join('\n')

    const entries = parseImportList(text)
    expect(entries).toHaveLength(2)
    expect(entries.map((e) => e.bundleID ?? e.appId)).toEqual(['com.apple.mobilesafari', 686449807])
  })

  it('distinguishes different versions of the same app', () => {
    const entries = parseImportList('id: 1, version_id: 100\nid: 1, version_id: 200')
    expect(entries).toHaveLength(2)
  })

  it('distinguishes different *display* versions of the same app (m-S6)', () => {
    const entries = parseImportList('com.example.app | Example | 10.5.1\ncom.example.app | Example | 10.5.2')
    expect(entries).toHaveLength(2)
    expect(entries.map((e) => e.version)).toEqual(['10.5.1', '10.5.2'])
  })

  it('still de-duplicates identical rows', () => {
    const entries = parseImportList('com.example.app | Example | 10.5.1\ncom.example.app | Example | 10.5.1')
    expect(entries).toHaveLength(1)
  })

  it('returns an empty list for garbage', () => {
    expect(parseImportList('hello\nworld\n')).toEqual([])
  })

  it('handles CRLF line endings', () => {
    expect(parseImportList('com.a.b\r\ncom.c.d\r\n')).toHaveLength(2)
  })
})
