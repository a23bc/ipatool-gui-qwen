/**
 * Parsing a pasted or imported list of apps into download requests.
 *
 * Users keep their "apps I want" lists in wildly different shapes, so this
 * accepts all of the common ones and normalises them:
 *
 *   com.apple.mobilesafari                      -> bundle identifier
 *   https://apps.apple.com/us/app/telegram/id686449807   -> track id
 *   686449807                                   -> bare track id
 *   686449807 | Telegram | 10.5.1               -> pipe-delimited row
 *   id: 686449807, name: Telegram               -> key/value row
 *
 * Keeping this pure means the whole matrix of formats is unit-testable without
 * touching the filesystem or the dialog layer.
 */

import type { DownloadRequest, Platform } from './types'
import { PLATFORMS } from './types'

/** Matches an Apple "apps.apple.com" URL and extracts the numeric track id. */
const APPLE_URL_ID = /\/id(\d{4,})/i
const BARE_ID = /^\d{4,}$/
/** Reverse-DNS bundle identifiers: at least two dot-separated labels. */
const BUNDLE_ID = /^[a-z0-9][\w-]*(\.[\w-]+)+$/i

export interface ParsedEntry extends DownloadRequest {
  /** Original text, kept so the UI can show what was understood. */
  source: string
}

function parsePlatform(value: string | undefined): Platform | undefined {
  if (!value) return undefined
  // Mirrors ipatool's own ParsePlatform aliases (pkg/appstore/platform.go) so a
  // list the user wrote for the CLI imports identically here.
  const normalized = value.trim().toLowerCase().replace(/[\s_]+/g, '-')
  const aliases: Record<string, Platform> = {
    ios: 'iphone',
    iphone: 'iphone',
    ipad: 'ipad',
    ipados: 'ipad',
    appletv: 'appletv',
    'apple-tv': 'appletv',
    tvos: 'appletv',
    vision: 'visionos',
    visionos: 'visionos',
    visionpro: 'visionos',
    xros: 'visionos',
    realitydevice: 'visionos',
    mac: 'macos',
    macos: 'macos',
    osx: 'macos'
  }
  const mapped = aliases[normalized]
  return mapped && PLATFORMS.includes(mapped) ? mapped : undefined
}

/** Parses one non-empty line. Returns null when nothing recognisable is found. */
export function parseEntry(rawLine: string): ParsedEntry | null {
  const line = rawLine.trim()
  if (line === '' || line.startsWith('#') || line.startsWith('//')) return null

  // A bare App Store URL is unambiguous.
  if (/^https?:\/\//i.test(line)) {
    const match = APPLE_URL_ID.exec(line)
    return match ? { source: line, appId: Number(match[1]) } : null
  }

  // Everything else is a sequence of cells; cells containing `key:`/`key=`
  // contribute named fields, the rest are positional.
  const cells = line
    .split(/[,;|\t]/)
    .map((cell) => cell.trim())
    .filter((cell) => cell !== '')

  const fields: Record<string, string> = {}
  const plain: string[] = []
  for (const cell of cells) {
    const match = cell.match(/^([A-Za-z_ ]+)[:=]\s*(.+)$/)
    const key = match?.[1]
    const value = match?.[2]
    if (key !== undefined && value !== undefined) {
      fields[key.trim().toLowerCase().replace(/\s+/g, '_')] = value.trim()
    } else {
      plain.push(cell)
    }
  }

  const idRaw = fields.id ?? fields.app_id ?? fields.appid ?? fields.track_id ?? fields.trackid
  const bundleFromKey = fields.bundle_id ?? fields.bundleid ?? fields.bundle ?? fields.package
  const urlField = fields.url ?? fields.link
  const urlId = urlField ? APPLE_URL_ID.exec(urlField)?.[1] : undefined

  const parsedId = idRaw ? Number(idRaw.replace(/[^\d]/g, '')) : Number.NaN
  let appId = Number.isFinite(parsedId) && parsedId > 0 ? parsedId : urlId ? Number(urlId) : 0

  let bundleID = bundleFromKey ?? ''
  let name = fields.name ?? fields.title ?? ''
  let version = fields.version ?? ''
  const externalVersionID = fields.external_version_id ?? fields.version_id ?? fields.external_version ?? ''
  const platform = parsePlatform(fields.platform)

  // Positional fallback: the first plain cell carries the identity, and when no
  // named keys were present the following cells are name / version by position.
  const primary = plain[0]
  const hasKeys = Object.keys(fields).length > 0
  if (primary !== undefined) {
    if (!bundleID && BUNDLE_ID.test(primary)) bundleID = primary
    else if (!appId && BARE_ID.test(primary)) appId = Number(primary)
    else if (/^https?:\/\//i.test(primary)) {
      const fromUrl = APPLE_URL_ID.exec(primary)?.[1]
      if (fromUrl) appId = Number(fromUrl)
    }

    if (!hasKeys) {
      if (!name && plain[1] && !BUNDLE_ID.test(plain[1]) && !BARE_ID.test(plain[1])) name = plain[1]
      if (!version && plain[2] && /^\d+(\.\d+)*$/.test(plain[2])) version = plain[2]
    }
  }

  if (!(appId > 0) && !BUNDLE_ID.test(bundleID)) return null

  return {
    source: line,
    ...(appId > 0 ? { appId } : {}),
    ...(bundleID ? { bundleID } : {}),
    ...(name ? { name } : {}),
    ...(version ? { version } : {}),
    ...(externalVersionID ? { externalVersionID } : {}),
    ...(platform ? { platform } : {})
  }
}

/** Parses a whole document, dropping duplicates and unrecognisable lines. */
export function parseImportList(text: string): ParsedEntry[] {
  const out: ParsedEntry[] = []
  const seen = new Set<string>()

  for (const rawLine of text.split(/\r?\n/)) {
    const entry = parseEntry(rawLine)
    if (!entry) continue
    // version is part of the identity: the same app at two different display
    // versions (without external IDs) is two legitimate download requests.
    const dedupeKey = `${entry.appId ?? 0}|${entry.bundleID ?? ''}|${entry.version ?? ''}|${entry.externalVersionID ?? ''}|${entry.platform ?? ''}`
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)
    out.push(entry)
  }

  return out
}
