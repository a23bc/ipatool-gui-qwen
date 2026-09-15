import { gunzipSync } from 'node:zlib'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { findTarFile, parseTar } from '@shared/tar'

// The fixture is a real GNU tar archive (gzipped) built with the same layout
// ipatool publishes on GitHub releases: `bin/<binary>` plus extra entries that
// exercise nested paths, a >100 char name (GNU longname) and directories.
const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/ipatool-release.tar.gz')
const archive = gunzipSync(readFileSync(fixture))
const entries = parseTar(archive)
const byName = new Map(entries.map((e) => [e.name, e]))

describe('parseTar', () => {
  it('reads every entry from a real GNU tar archive', () => {
    const names = entries.map((e) => e.name)
    expect(names).toContain('bin/ipatool-2.6.0-linux-amd64')
    expect(names).toContain('notes/readme.txt')
    expect(names).toContain('deep/a/b/c/d/e/f/g/h/inner.bin')
  })

  it('preserves the executable mode bit', () => {
    const binary = byName.get('bin/ipatool-2.6.0-linux-amd64')!
    expect(binary.type).toBe('file')
    // 0o755 & 0o777 - the mode field includes file-type bits in some archives.
    expect(binary.mode & 0o777).toBe(0o755)
  })

  it('returns byte-exact contents', () => {
    const readme = byName.get('notes/readme.txt')!
    expect(Buffer.from(readme.data!).toString('utf8')).toBe('hello')
    expect(readme.size).toBe(5)
  })

  it('handles deeply nested paths via the ustar prefix field', () => {
    const nested = byName.get('deep/a/b/c/d/e/f/g/h/inner.bin')!
    expect(Buffer.from(nested.data!).toString('utf8')).toBe('nested')
  })

  it('handles names longer than 100 chars via the GNU longname record', () => {
    const long = entries.find((e) => e.name.startsWith('long/L'))
    expect(long).toBeDefined()
    expect(long!.name.length).toBeGreaterThan(100)
    expect(Buffer.from(long!.data!).toString('utf8')).toBe('longname-payload')
  })

  it('marks directories and gives them no data', () => {
    const dir = byName.get('bin/') ?? byName.get('bin')
    expect(dir).toBeDefined()
    expect(dir!.type).toBe('directory')
    expect(dir!.data).toBeNull()
  })

  it('returns an empty list for an empty archive', () => {
    expect(parseTar(new Uint8Array(2048))).toEqual([])
  })
})

describe('parseTar (pax / bsdtar archives)', () => {
  // macOS ships bsdtar, which emits pax extended headers by default. The CI
  // matrix builds on macOS, so this layout must be handled too.
  const paxArchive = gunzipSync(
    readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/ipatool-release-pax.tar.gz'))
  )
  const paxEntries = parseTar(paxArchive)
  const names = paxEntries.map((e) => e.name)

  it('skips the internal PaxHeaders records instead of exposing them', () => {
    expect(names.some((n) => n.includes('PaxHeaders'))).toBe(false)
  })

  it('still finds the real files with intact contents', () => {
    expect(names).toContain('bin/ipatool-2.6.0-linux-amd64')
    expect(names).toContain('notes/readme.txt')
    const readme = paxEntries.find((e) => e.name === 'notes/readme.txt')!
    expect(Buffer.from(readme.data!).toString('utf8')).toBe('hello')
  })

  it('is usable by the same lookup the installer performs', () => {
    const found = findTarFile(paxEntries, (base) => base.startsWith('ipatool-'))
    expect(found!.name).toBe('bin/ipatool-2.6.0-linux-amd64')
  })
})

describe('findTarFile', () => {
  it('locates the ipatool binary the way the installer does', () => {
    const found = findTarFile(entries, (base) => base.startsWith('ipatool-'))
    expect(found).not.toBeNull()
    expect(found!.name).toBe('bin/ipatool-2.6.0-linux-amd64')
  })

  it('ignores directories', () => {
    expect(findTarFile(entries, () => true)!.type).toBe('file')
  })

  it('returns null when nothing matches', () => {
    expect(findTarFile(entries, (base) => base.endsWith('.exe'))).toBeNull()
  })
})

/* ------------------------------------------------------------------ *
 * Synthetic archives: path-traversal defence (M9), symlinks, base-256.
 * ------------------------------------------------------------------ */

import { safeName } from '@shared/tar'

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/** Builds a minimal ustar header block (checksum left blank - not validated). */
function makeHeader(name: string, size: number, typeFlag: string, linkName = ''): Uint8Array {
  const block = new Uint8Array(512)
  const write = (value: string, offset: number, length: number): void => {
    for (let i = 0; i < value.length && i < length; i += 1) block[offset + i] = value.charCodeAt(i)
  }
  write(name, 0, 100)
  write('0000644\0', 100, 8)
  write('0000000\0', 108, 8)
  write('0000000\0', 116, 8)
  write(size.toString(8).padStart(11, '0') + '\0', 124, 12)
  write('14503353400\0', 136, 12)
  write('        ', 148, 8)
  block[156] = typeFlag.charCodeAt(0)
  write(linkName, 157, 100)
  write('ustar\0', 257, 6)
  write('00', 263, 2)
  return block
}

function makeFileEntry(name: string, content: string): Uint8Array {
  const data = new TextEncoder().encode(content)
  const padded = new Uint8Array(Math.ceil(data.length / 512) * 512)
  padded.set(data)
  return concat(makeHeader(name, data.length, '0'), padded)
}

function makeSymlinkEntry(name: string, target: string): Uint8Array {
  return makeHeader(name, 0, '2', target)
}

const END_BLOCKS = new Uint8Array(1024)

describe('parseTar path-safety (M9)', () => {
  it('rejects parent-traversal names but keeps parsing the rest', () => {
    const archive = concat(
      makeFileEntry('../evil.txt', 'pwned'),
      makeFileEntry('deep/../../evil2.txt', 'pwned'),
      makeFileEntry('good/hello.txt', 'hello'),
      END_BLOCKS
    )
    const parsed = parseTar(archive)
    expect(parsed.map((e) => e.name)).toEqual(['good/hello.txt'])
    expect(Buffer.from(parsed[0]!.data!).toString('utf8')).toBe('hello')
  })

  it('rejects absolute paths (POSIX and Windows)', () => {
    const archive = concat(
      makeFileEntry('/etc/passwd', 'root:x:0:0'),
      makeFileEntry('C:\\Windows\\system32\\evil.dll', 'MZ'),
      makeFileEntry('ok.txt', 'ok'),
      END_BLOCKS
    )
    expect(parseTar(archive).map((e) => e.name)).toEqual(['ok.txt'])
  })

  it('rejects entries whose symlink target escapes the root', () => {
    const archive = concat(
      makeSymlinkEntry('link-out', '../../etc/passwd'),
      makeSymlinkEntry('link-abs', '/etc/passwd'),
      makeSymlinkEntry('link-ok', 'sibling/file.txt'),
      END_BLOCKS
    )
    const parsed = parseTar(archive)
    expect(parsed.map((e) => e.name)).toEqual(['link-ok'])
    expect(parsed[0]!.type).toBe('symlink')
    expect(parsed[0]!.linkTarget).toBe('sibling/file.txt')
  })

  it('rejects a malicious GNU longname payload', () => {
    const longName = '../../../tmp/evil.bin'
    const nameData = new TextEncoder().encode(longName + '\0')
    const padded = new Uint8Array(512)
    padded.set(nameData)
    const archive = concat(
      makeHeader('././@LongLink', nameData.length, 'L'),
      padded,
      makeFileEntry('ignored.txt', 'x'), // the header the longname annotates
      makeFileEntry('safe.txt', 'safe'),
      END_BLOCKS
    )
    const parsed = parseTar(archive)
    expect(parsed.map((e) => e.name)).toEqual(['safe.txt'])
  })

  it('normalizes backslash separators and leading "./"', () => {
    const archive = concat(makeFileEntry('.\\dir\\file.txt', 'x'), END_BLOCKS)
    const parsed = parseTar(archive)
    expect(parsed.map((e) => e.name)).toEqual(['dir/file.txt'])
  })
})

describe('safeName', () => {
  it('accepts plain relative names', () => {
    expect(safeName('bin/ipatool')).toBe('bin/ipatool')
    expect(safeName('./bin/ipatool')).toBe('bin/ipatool')
  })

  it('rejects traversal and absolute names', () => {
    expect(safeName('../x')).toBeNull()
    expect(safeName('a/../b')).toBeNull()
    expect(safeName('a/..')).toBeNull()
    expect(safeName('/x')).toBeNull()
    expect(safeName('\\x')).toBeNull()
    expect(safeName('C:\\x')).toBeNull()
    expect(safeName('')).toBeNull()
  })

  it('does not false-positive on legitimate names containing dots', () => {
    expect(safeName('com.example.app_1.0.ipa')).toBe('com.example.app_1.0.ipa')
    expect(safeName('..hidden/file')).toBe('..hidden/file')
  })
})

describe('parseTar base-256 sizes', () => {
  it('decodes the GNU binary size encoding', () => {
    const content = 'hello'
    const block = makeHeader('b256.txt', 0, '0')
    // Overwrite the size field (offset 124, 12 bytes) with base-256 for 5.
    block[124] = 0x80
    for (let i = 125; i < 136; i += 1) block[i] = 0
    block[135] = content.length
    const data = new Uint8Array(512)
    data.set(new TextEncoder().encode(content))
    const parsed = parseTar(concat(block, data, END_BLOCKS))
    expect(parsed).toHaveLength(1)
    expect(parsed[0]!.size).toBe(5)
    expect(Buffer.from(parsed[0]!.data!).toString('utf8')).toBe('hello')
  })
})
