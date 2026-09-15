/**
 * Builds ipatool command lines.
 *
 * Every function here maps 1:1 onto a real ipatool sub-command and only ever
 * emits flags that exist in ipatool v2.x. Keeping this in one pure module means
 * the command surface can be unit-tested without spawning anything, and the
 * renderer can show the exact command it is about to run.
 *
 * Reference (ipatool v2.6):
 *   global : --format text|json --verbose --non-interactive --keychain-passphrase <s>
 *   auth login -e <email> -p <password> [--auth-code <code>]
 *   auth info | auth revoke
 *   search <term> [-l <limit>] [--platform <p>]
 *   download [-i <id> | -b <bundleId>] [-o <path>] [--external-version-id <v>] [--platform <p>] [--purchase]
 *   list-versions [-i <id> | -b <bundleId>] [--platform <p>]
 *   list-purchases [-l <maxResults>] [-p <page>] [--platform <p>]
 *   purchase [-i <id> | -b <bundleId>] [--platform <p>]
 *   get-version-metadata [-i <id> | -b <bundleId>] --external-version-id <v> [--platform <p>]
 */

import type { Platform } from '../types'

export interface GlobalOptions {
  /** `json` for machine-readable output. Defaults to `json`. */
  format?: 'text' | 'json'
  /** Enables ipatool's verbose/debug log level. */
  verbose?: boolean
  /**
   * When true, `--non-interactive` is appended and ipatool will never block on
   * a prompt. Set to false for `download`, which only renders its progress bar
   * in interactive mode.
   */
  nonInteractive?: boolean
  /** Unlocks ipatool's file-backed keyring (required on Windows). */
  keychainPassphrase?: string
}

export interface AppSelector {
  appId?: number
  bundleID?: string
}

function pushPlatform(args: string[], platform: Platform | undefined): void {
  if (platform !== undefined && platform !== '') args.push('--platform', platform)
}

function pushSelector(args: string[], selector: AppSelector): void {
  if (typeof selector.appId === 'number' && selector.appId > 0) {
    args.push('-i', String(selector.appId))
  }
  if (selector.bundleID && selector.bundleID.trim() !== '') {
    args.push('-b', selector.bundleID.trim())
  }
}

/** Appends the global flags. Cobra accepts persistent flags in any position. */
export function withGlobals(args: string[], options: GlobalOptions = {}): string[] {
  const format = options.format ?? 'json'
  const out = [...args, '--format', format]
  if (options.verbose) out.push('--verbose')
  if (options.nonInteractive !== false) out.push('--non-interactive')
  if (options.keychainPassphrase) out.push('--keychain-passphrase', options.keychainPassphrase)
  return out
}

export function versionArgs(): string[] {
  return ['--version']
}

export function loginArgs(email: string, password: string, authCode?: string): string[] {
  const args = ['auth', 'login', '-e', email, '-p', password]
  if (authCode && authCode.trim() !== '') args.push('--auth-code', authCode.trim())
  return args
}

export function accountInfoArgs(): string[] {
  return ['auth', 'info']
}

export function revokeArgs(): string[] {
  return ['auth', 'revoke']
}

export interface SearchOptions {
  limit?: number
  platform?: Platform
}

export function searchArgs(term: string, options: SearchOptions = {}): string[] {
  const args = ['search', term]
  if (typeof options.limit === 'number' && options.limit > 0) args.push('-l', String(options.limit))
  pushPlatform(args, options.platform)
  return args
}

export interface DownloadOptions extends AppSelector {
  /** Directory (or full file path) passed to `--output`. */
  output?: string
  externalVersionID?: string
  platform?: Platform
  purchase?: boolean
}

export function downloadArgs(options: DownloadOptions): string[] {
  const args = ['download']
  pushSelector(args, options)
  if (options.output && options.output.trim() !== '') args.push('-o', options.output)
  if (options.externalVersionID && options.externalVersionID.trim() !== '') {
    args.push('--external-version-id', options.externalVersionID.trim())
  }
  pushPlatform(args, options.platform)
  if (options.purchase) args.push('--purchase')
  return args
}

export interface ListVersionsOptions extends AppSelector {
  platform?: Platform
}

export function listVersionsArgs(options: ListVersionsOptions): string[] {
  const args = ['list-versions']
  pushSelector(args, options)
  pushPlatform(args, options.platform)
  return args
}

export interface ListPurchasesOptions {
  page?: number
  maxResults?: number
  platform?: Platform
}

export function listPurchasesArgs(options: ListPurchasesOptions = {}): string[] {
  const args = ['list-purchases']
  if (typeof options.maxResults === 'number' && options.maxResults > 0) {
    args.push('-l', String(options.maxResults))
  }
  if (typeof options.page === 'number' && options.page > 0) args.push('-p', String(options.page))
  pushPlatform(args, options.platform)
  return args
}

export interface PurchaseOptions extends AppSelector {
  platform?: Platform
}

export function purchaseArgs(options: PurchaseOptions): string[] {
  const args = ['purchase']
  pushSelector(args, options)
  pushPlatform(args, options.platform)
  return args
}

export interface VersionMetadataOptions extends AppSelector {
  externalVersionID: string
  platform?: Platform
}

export function versionMetadataArgs(options: VersionMetadataOptions): string[] {
  const args = ['get-version-metadata']
  pushSelector(args, options)
  args.push('--external-version-id', String(options.externalVersionID).trim())
  pushPlatform(args, options.platform)
  return args
}

/**
 * ipatool derives the package file name from the app metadata:
 *   `<bundleID>_<appID>_<version>.ipa`   (`.pkg` for macOS)
 * Used to predict the on-disk destination and to locate the resumable `.tmp`.
 */
export function packageFileName(
  bundleID: string,
  appId: number,
  version: string,
  platform: Platform
): string {
  // version (and in theory bundleID) can be user-supplied via an import list,
  // so strip path separators and leading dots: neither may turn the predicted
  // file name into a path-traversal payload like `../../etc/passwd.ipa`.
  const sanitize = (value: string): string => value.replace(/[\\/]/g, '_').replace(/^\.+/, '')

  const parts: string[] = []
  if (bundleID) parts.push(sanitize(bundleID))
  if (appId) parts.push(String(appId))
  if (version) parts.push(sanitize(version))
  const ext = platform === 'macos' ? 'pkg' : 'ipa'
  return `${parts.join('_')}.${ext}`
}
