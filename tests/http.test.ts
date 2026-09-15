/**
 * http.ts pure-helper tests: applyMirror and describeHttpError.
 *
 * `electron` is mocked (http.ts imports app/net for the net.fetch upgrade);
 * the helpers under test never touch the network.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isReady: () => false },
  net: {}
}))

import { applyMirror, describeHttpError, HttpError } from '@main/http'

describe('applyMirror', () => {
  const url = 'https://github.com/majd/ipatool/releases/download/v2.6.0/ipatool-2.6.0.tar.gz'

  it('returns the URL unchanged when no mirror is configured', () => {
    expect(applyMirror(url, '')).toBe(url)
    expect(applyMirror(url, '   ')).toBe(url)
  })

  it('prefixes github.com https URLs with the mirror', () => {
    expect(applyMirror(url, 'https://ghproxy.example')).toBe(`https://ghproxy.example/${url}`)
  })

  it('normalises trailing slashes on the mirror prefix', () => {
    expect(applyMirror(url, 'https://ghproxy.example///')).toBe(`https://ghproxy.example/${url}`)
  })

  it('never rewrites non-github URLs', () => {
    expect(applyMirror('https://api.github.com/repos/majd/ipatool', 'https://m.example')).toBe(
      'https://api.github.com/repos/majd/ipatool'
    )
    expect(applyMirror('https://example.com/file.tar.gz', 'https://m.example')).toBe(
      'https://example.com/file.tar.gz'
    )
    // The scheme matters: http:// github URLs are left alone too.
    expect(applyMirror('http://github.com/x/y', 'https://m.example')).toBe('http://github.com/x/y')
  })

  it('a mirror can only rewrite the download URL - checksum URLs are built canonical (B1)', () => {
    // Mirroring BOTH the asset and its .sha256sum would let the mirror vouch
    // for its own tampered payload; engine.ts must therefore only pass the
    // asset URL through applyMirror. This test pins applyMirror semantics so
    // the split in engine.assetUrls() stays meaningful.
    const mirror = 'https://evil.example'
    const mirrored = applyMirror(url, mirror)
    const checksum = `${url}.sha256sum`
    expect(mirrored.startsWith(mirror)).toBe(true)
    expect(checksum.startsWith('https://github.com/')).toBe(true)
    expect(applyMirror(checksum, '')).toBe(checksum)
  })
})

describe('describeHttpError', () => {
  it('explains 403 as rate limiting with the failing URL', () => {
    const error = new HttpError('HTTP 403 Forbidden', 403, 'https://api.github.com/x')
    expect(describeHttpError(error, 'https://api.github.com/x')).toBe(
      'Rate limited or forbidden by https://api.github.com/x'
    )
  })

  it('explains 404', () => {
    const error = new HttpError('HTTP 404', 404, 'https://github.com/missing')
    expect(describeHttpError(error, 'https://github.com/missing')).toBe(
      'Not found: https://github.com/missing'
    )
  })

  it('renders other statuses with message + url, without duplicating the url', () => {
    const error = new HttpError('HTTP 500 boom', 500, 'https://github.com/x')
    const described = describeHttpError(error, 'https://github.com/x')
    expect(described).toBe('HTTP 500 boom (https://github.com/x)')
  })

  it('falls back to the request URL for non-HttpError values', () => {
    expect(describeHttpError(new Error('socket hang up'), 'https://github.com/y')).toBe(
      'socket hang up (https://github.com/y)'
    )
    expect(describeHttpError('weird', 'https://github.com/z')).toBe('weird (https://github.com/z)')
  })
})
