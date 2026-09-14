/**
 * Self-update check.
 *
 * Deliberately *not* electron-updater: automatic binary replacement needs code
 * signing on macOS and an update server contract, and a half-working updater is
 * worse than none. Instead we ask GitHub for the newest release tag and let the
 * user decide, linking straight to the release page.
 *
 * The repository slug is injected at build time (`APP_REPO` in CI), so a fork
 * gets update checks against its own repo with no source edits.
 */

import type { UpdateCheckResult } from '../shared/types'
import { isNewer } from '../shared/semver'
import { fetchJson } from './http'

declare const __APP_VERSION__: string
declare const __APP_REPO__: string

export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0'
export const APP_REPO: string = typeof __APP_REPO__ === 'string' ? __APP_REPO__ : ''
declare const __APP_PRODUCT__: string
export const APP_PRODUCT: string = typeof __APP_PRODUCT__ === 'string' ? __APP_PRODUCT__ : 'IPATool GUI'

interface GhRelease {
  tag_name: string
  html_url: string
  published_at: string | null
  prerelease: boolean
}

export function updateCheckAvailable(): boolean {
  return APP_REPO.includes('/')
}

export async function checkAppUpdate(): Promise<UpdateCheckResult> {
  const base: UpdateCheckResult = {
    current: APP_VERSION,
    latest: null,
    hasUpdate: false,
    url: null,
    publishedAt: null,
    error: null
  }

  if (!updateCheckAvailable()) {
    return { ...base, error: 'update-check-not-configured' }
  }

  try {
    const release = await fetchJson<GhRelease>(
      `https://api.github.com/repos/${APP_REPO}/releases/latest`
    )
    const latest = release?.tag_name?.replace(/^v/, '') ?? ''
    if (!latest) return { ...base, error: 'no-release' }
    return {
      current: APP_VERSION,
      latest,
      hasUpdate: isNewer(latest, APP_VERSION),
      url: release.html_url ?? `https://github.com/${APP_REPO}/releases/latest`,
      publishedAt: release.published_at ?? null,
      error: null
    }
  } catch (error) {
    return { ...base, error: error instanceof Error ? error.message : String(error) }
  }
}
