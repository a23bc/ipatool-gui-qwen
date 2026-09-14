/**
 * A tiny, dependency-free tar reader.
 *
 * ipatool's GitHub release assets are `.tar.gz` archives containing a single
 * `bin/ipatool-<version>-<os>-<arch>[.exe]` entry. Pulling in a tar package for
 * that would bloat the bundle and add a native-ish dependency chain, so we parse
 * the (very stable) ustar layout directly.
 *
 * Supports: ustar names + prefixes, GNU long names ('L'), pax extended headers
 * ('x'/'g'), base-256 size encoding, and the regular/dir/symlink type flags.
 * The module is pure - callers gunzip with zlib before handing data in.
 */

const BLOCK = 512

export type TarEntryType = 'file' | 'directory' | 'symlink' | 'link' | 'other'

export interface TarEntry {
  name: string
  type: TarEntryType
  size: number
  /** POSIX permission bits, e.g. 0o755. */
  mode: number
  mtime: number
  /** File contents; null for directories/links/special entries. */
  data: Uint8Array | null
  linkTarget: string
}

function readString(buffer: Uint8Array, offset: number, length: number): string {
  let end = offset
  const limit = offset + length
  while (end < limit && buffer[end] !== 0) end += 1
  // Tar strings are NUL-padded but not always NUL-terminated.
  return decodeUtf8(buffer.subarray(offset, end)).replace(/\0+$/, '')
}

function decodeUtf8(bytes: Uint8Array): string {
  if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(bytes)
  // Node fallback (TextDecoder is global in Node >= 11, but be defensive).
  return Buffer.from(bytes).toString('utf8')
}

/** Parses an octal field, including GNU's base-256 extension for huge sizes. */
function readNumber(buffer: Uint8Array, offset: number, length: number): number {
  if (length <= 0) return 0
  const first = buffer[offset]
  if (first & 0x80) {
    // Base-256: big-endian, sign bit in the first byte.
    let value = first & 0x40 ? -1 : 0
    for (let i = 0; i < length; i += 1) {
      value = value * 256 + buffer[offset + i]
    }
    if (first & 0x40) {
      value -= 256 ** length
    }
    return value
  }
  const raw = readString(buffer, offset, length).trim()
  if (raw === '') return 0
  const parsed = Number.parseInt(raw, 8)
  return Number.isFinite(parsed) ? parsed : 0
}

function isZeroBlock(buffer: Uint8Array, offset: number): boolean {
  for (let i = offset; i < offset + BLOCK; i += 1) {
    if (buffer[i] !== 0) return false
  }
  return true
}

/**
 * Maps a tar typeflag byte to a coarse type.
 *
 * Note the regular-file flag is the ASCII character '0' (48) in ustar/GNU
 * archives; a literal NUL byte (0) is the old pre-ustar spelling. Both must be
 * accepted or every file silently degrades to "other".
 */
function typeFor(flag: number): TarEntryType {
  switch (flag) {
    case 0: // NUL - pre-ustar regular file
    case '0'.charCodeAt(0):
    case '7'.charCodeAt(0): // contiguous file
      return 'file'
    case '5'.charCodeAt(0):
      return 'directory'
    case '2'.charCodeAt(0):
      return 'symlink'
    case '1'.charCodeAt(0):
      return 'link'
    default:
      return 'other'
  }
}

/** Parses pax extended header records: "<length> <key>=<value>\n". */
function parsePax(data: Uint8Array): Record<string, string> {
  const text = decodeUtf8(data)
  const out: Record<string, string> = {}
  let i = 0
  while (i < text.length) {
    const space = text.indexOf(' ', i)
    if (space === -1) break
    const length = Number.parseInt(text.slice(i, space), 10)
    if (!Number.isFinite(length) || length <= 0) break
    const record = text.slice(i, i + length)
    const eq = record.indexOf('=')
    if (eq > space - i) {
      const key = record.slice(space - i + 1, eq)
      // Drop the trailing newline that is counted in <length>.
      out[key] = record.slice(eq + 1, record.length - 1)
    }
    i += length
  }
  return out
}

export function parseTar(input: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = []
  let offset = 0
  let longName: string | null = null
  let longLink: string | null = null
  let paxPath: string | null = null
  let zeroBlocks = 0

  while (offset + BLOCK <= input.length) {
    if (isZeroBlock(input, offset)) {
      zeroBlocks += 1
      offset += BLOCK
      // Two consecutive zero blocks mark the end of an archive.
      if (zeroBlocks >= 2) break
      continue
    }
    zeroBlocks = 0

    const header = input.subarray(offset, offset + BLOCK)
    const rawName = readString(header, 0, 100)
    const mode = readNumber(header, 100, 8)
    const size = readNumber(header, 124, 12)
    const mtime = readNumber(header, 136, 12)
    const typeFlag = header[156] ?? 0
    const linkName = readString(header, 157, 100)
    const magic = readString(header, 257, 6)
    const prefix = magic.startsWith('ustar') ? readString(header, 345, 155) : ''

    const dataOffset = offset + BLOCK
    const data = size > 0 ? input.subarray(dataOffset, dataOffset + size) : new Uint8Array(0)
    const padded = Math.ceil(size / BLOCK) * BLOCK
    offset = dataOffset + padded

    const flagChar = String.fromCharCode(typeFlag)

    // GNU long name / long link: the payload is the real value for the *next*
    // header, which itself has a dummy name.
    if (flagChar === 'L') {
      longName = decodeUtf8(data).replace(/\0+$/, '')
      continue
    }
    if (flagChar === 'K') {
      longLink = decodeUtf8(data).replace(/\0+$/, '')
      continue
    }
    if (flagChar === 'x' || flagChar === 'X' || flagChar === 'g') {
      // Pax headers annotate the *next* entry; they never produce one of their
      // own. Their own name is usually "./PaxHeaders.X/..." which we must drop.
      const attrs = parsePax(data)
      if (attrs.path) paxPath = attrs.path
      continue
    }

    let name = longName ?? paxPath ?? (prefix ? `${prefix}/${rawName}` : rawName)
    const link = longLink ?? linkName

    longName = null
    longLink = null
    paxPath = null

    if (name === '') continue

    const type = typeFor(typeFlag)
    entries.push({
      // Strip a leading "./" so consumers can match on plain relative paths.
      name: name.replace(/^\.\//, ''),
      type,
      size: type === 'file' ? size : 0,
      mode,
      mtime,
      data: type === 'file' ? Uint8Array.from(data) : null,
      linkTarget: link
    })
  }

  return entries
}

/** Finds the first regular file whose basename matches, ignoring directories. */
export function findTarFile(
  entries: TarEntry[],
  predicate: (name: string) => boolean
): TarEntry | null {
  for (const entry of entries) {
    if (entry.type !== 'file' || !entry.data) continue
    const base = entry.name.split('/').pop() ?? entry.name
    if (predicate(base)) return entry
  }
  return null
}
