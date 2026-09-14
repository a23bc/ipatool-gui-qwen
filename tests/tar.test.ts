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
