/**
 * Multi-account primitives (platform- and IO-free, so they can be unit tested).
 *
 * Everything here is grounded in ipatool v2.6 (`majd/ipatool`), because the whole
 * feasibility of several accounts at once depends on how upstream stores a
 * session:
 *
 * 1. **Session directory** - `cmd/state_directory.go` computes
 *    `stateDirectory = $XDG_STATE_HOME/ipatool` (falling back to
 *    `$XDG_DATA_HOME/ipatool`) when the variable holds an *absolute* path, and
 *    `legacyDirectory = $HOME/.ipatool` otherwise. When the legacy directory
 *    exists ipatool **prefers it** - and if it does not exist alongside an
 *    existing XDG target it *renames the legacy directory into it*. Both
 *    branches silently make several sessions share one store, so the GUI
 *    sandboxes `HOME` (`HOMEDRIVE`/`HOMEPATH` on Windows - `machine.HomeDirectory`
 *    is the only reader of either) and always passes an absolute
 *    `XDG_STATE_HOME`. `pkg/util/machine/machine.go` is the only consumer, so the
 *    sandbox cannot affect anything else ipatool does.
 *
 * 2. **Credential record** - `cmd/common.go` opens the keyring with the *fixed*
 *    `KeychainServiceName = "ipatool-auth.service"` and the backend list
 *    `[keychain, secret-service, file]`. `keyring.Open` returns the **first**
 *    backend that opens successfully, and on macOS the release builds use
 *    `CGO_ENABLED=1`, so the login Keychain always wins; Linux picks the Secret
 *    Service whenever a keyring daemon answers on the session bus. Only the
 *    `file` backend is scoped to the state directory (`keyring.Config.FileDir`),
 *    which is why Windows - where neither `keychain` nor `secret-service` is even
 *    registered, and `wincred` is *not* in the allowed list - is the one platform
 *    where a session is fully isolated by its directory alone.
 *
 *    That single shared slot is the real constraint behind multi-account, and it
 *    is also *read on every command*: `cmd/search.go`, `download.go`,
 *    `purchase.go`, `purchases.go`, `list_versions.go` and
 *    `get_version_metadata.go` all call `AppStore.AccountInfo()` first, which
 *    reads the record (`pkg/appstore/appstore_account_info.go`) and feeds
 *    StoreFront/Pod/DirectoryServicesID into the request. So a slot holding
 *    somebody else's account does not merely mislabel the UI - it changes what
 *    Apple is asked for, and with whose identity.
 *
 * 3. **What the record contains** - `pkg/appstore/appstore_login.go` marshals the
 *    whole `Account` struct (see `pkg/appstore/account.go`) under the key
 *    `"account"`, *including the Apple ID password*. Anything that snapshots it
 *    must therefore be treated as secret material.
 *
 * Consequences encoded below:
 *   - an account is identified by `directoryServicesIdentifier` when present, and
 *     by e-mail as the fallback;
 *   - accounts are only truly independent when the credential store is the
 *     per-directory file; when it is the machine-wide slot the GUI has to move
 *     the right record into that slot before use.
 */

import type { AccountProfile, NodePlatform } from './types'

/** `cmd/constants.go` - used verbatim when talking to the OS credential store. */
export const IPATOOL_KEYCHAIN_SERVICE = 'ipatool-auth.service'
/** The single key ipatool stores the account record under. */
export const IPATOOL_KEYCHAIN_KEY = 'account'
/** `ConfigDirectoryName` in `cmd/constants.go`, relative to the home directory. */
export const LEGACY_STATE_DIRNAME = '.ipatool'
/** Subdirectory ipatool appends to `$XDG_STATE_HOME`. */
export const XDG_STATE_SUBDIR = 'ipatool'

/* ------------------------------------------------------------------ *
 * Identity
 * ------------------------------------------------------------------ */

/** The JSON blob ipatool keeps under the `account` key. */
export interface AccountRecord {
  email?: string
  name?: string
  passwordToken?: string
  directoryServicesIdentifier?: string
  storeFront?: string
  /** Present in the record; never displayed, never logged. */
  password?: string
  pod?: string
}

export interface AccountIdentity {
  email: string
  dsid: string
}

/**
 * Parses a raw credential record.
 *
 * Returns null unless the payload is a JSON object that identifies an account:
 * the slot is shared with the terminal CLI and with any other tool using the
 * same service name, so "parses as JSON" is not enough - a record with neither
 * an e-mail nor a DirectoryServicesID cannot be attributed to anybody and must
 * not be mistaken for a usable session.
 */
export function parseAccountRecord(raw: string | null | undefined): AccountRecord | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null

  const source = parsed as Record<string, unknown>
  const str = (key: string): string => (typeof source[key] === 'string' ? (source[key] as string) : '')

  const record: AccountRecord = {
    email: str('email').trim(),
    name: str('name').trim(),
    passwordToken: str('passwordToken'),
    directoryServicesIdentifier: str('directoryServicesIdentifier').trim(),
    storeFront: str('storeFront'),
    pod: str('pod')
  }
  if (typeof source.password === 'string') record.password = source.password

  return record.email === '' && record.directoryServicesIdentifier === '' ? null : record
}

export function identityOf(record: AccountRecord | null): AccountIdentity {
  if (!record) return { email: '', dsid: '' }
  return { email: (record.email ?? '').trim().toLowerCase(), dsid: (record.directoryServicesIdentifier ?? '').trim() }
}

/**
 * True when both sides describe the same Apple account.
 *
 * A DirectoryServicesID on both sides is decisive (it survives an e-mail change
 * and is what Apple itself keys the licence on). When either side lacks one we
 * fall back to the e-mail, and when *both* are unknown we refuse to claim a
 * match - "nothing vs. nothing" must never be read as "same account", which is
 * how a signed-out profile could otherwise be treated as the active session.
 *
 * Both sides are normalised here rather than at the call sites: Apple IDs are
 * case-insensitive, and one caller forgetting to lower-case would turn a
 * legitimate session into a "somebody else owns this" conflict.
 */
export function sameIdentity(a: AccountIdentity, b: AccountIdentity): boolean {
  const dsidA = a.dsid.trim()
  const dsidB = b.dsid.trim()
  if (dsidA !== '' && dsidB !== '') return dsidA === dsidB

  const emailA = a.email.trim().toLowerCase()
  const emailB = b.email.trim().toLowerCase()
  if (emailA !== '' && emailB !== '') return emailA === emailB
  return false
}

export function profileIdentity(profile: AccountProfile): AccountIdentity {
  return { email: profile.email.trim().toLowerCase(), dsid: profile.dsid.trim() }
}

/** Which profile currently owns the record found in the shared slot. */
export function slotOwner(record: AccountRecord | null, profiles: AccountProfile[]): AccountProfile | null {
  const identity = identityOf(record)
  if (identity.email === '' && identity.dsid === '') return null
  return profiles.find((profile) => sameIdentity(profileIdentity(profile), identity)) ?? null
}

/* ------------------------------------------------------------------ *
 * Platform capability
 * ------------------------------------------------------------------ */

export type CredentialSlot = 'file' | 'os'

/**
 * Whether ipatool will most likely scope credentials to the session directory
 * (`file`) or to one machine-wide OS slot (`os`).
 *
 * This is a *prior* used for messaging; the authoritative answer is measured at
 * runtime by looking at the account's own directory after a successful login
 * (see `accounts.credentialStore`).
 */
export function probableCredentialSlot(platform: NodePlatform): CredentialSlot {
  // macOS: `CGO_ENABLED=1` release builds register the Keychain backend, and it
  // is the first entry in AllowedBackends, so it always wins.
  if (platform === 'darwin') return 'os'
  // Linux: `secret-service` is second in the list and opens whenever a keyring
  // daemon is reachable on the session bus. Headless/minimal desktops fall
  // through to `file`.
  if (platform === 'linux') return 'os'
  // Windows: only `wincred` and `file` are registered, and `wincred` is absent
  // from AllowedBackends, so `file` - inside the state directory - is used.
  return 'file'
}

/** Environment fragment written when the credential store is the file backend. */
export function sandboxHomeFor(platform: NodePlatform): Array<'HOME' | 'HOMEDRIVE' | 'HOMEPATH'> {
  return platform === 'win32' ? ['HOMEDRIVE', 'HOMEPATH'] : ['HOME']
}

/* ------------------------------------------------------------------ *
 * Naming & ordering
 * ------------------------------------------------------------------ */

/** `a` + base36 timestamp + 32 CSPRNG bits, so ids never collide nor look positional. */
export function newAccountId(now: number, randomHex: string): string {
  const stamp = Math.max(0, Math.floor(now)).toString(36)
  const noise = randomHex.replace(/[^0-9a-z]/gi, '').slice(0, 8).toLowerCase()
  return `a${stamp}${noise}`
}

export function isAccountId(value: unknown): value is string {
  return typeof value === 'string' && /^a[0-9a-z]{6,40}$/.test(value)
}

/**
 * Directory name for an account.
 *
 * Ids are generated, never user-supplied, but they end up in a filesystem path,
 * so anything that could escape the accounts root (separators, dots, drive
 * prefixes) is dropped before use.
 */
export function accountDirName(id: string): string {
  const safe = id.replace(/[^0-9a-zA-Z]/g, '')
  return safe === '' ? 'a0000000' : safe
}

/** Label shown in the switcher: the learned name, else e-mail, else the note. */
export function accountDisplayName(profile: AccountProfile): string {
  const name = profile.name.trim()
  if (name !== '') return name
  const email = profile.email.trim()
  if (email !== '') return email
  const remark = profile.remark.trim()
  return remark !== '' ? remark : 'Account'
}

/**
 * Allocates the next "Account N" label.
 *
 * The counter is persisted rather than derived from the current list, so
 * deleting an account can never recycle a label and leave two entries that look
 * identical in the switcher (which once made a switch look like an overwrite).
 */
export function allocateAccountName(profiles: AccountProfile[], counter: number): {
  name: string
  counter: number
} {
  const used = new Set(profiles.map((profile) => profile.name.trim().toLowerCase()).filter(Boolean))
  let next = Math.max(1, Math.round(counter) || 1)
  while (used.has(`account ${next}`)) next += 1
  return { name: `Account ${next}`, counter: next + 1 }
}

/** Most recently used first; ties fall back to creation order. */
export function sortAccounts(profiles: AccountProfile[]): AccountProfile[] {
  return [...profiles].sort((a, b) => b.lastUsedAt - a.lastUsedAt || a.createdAt - b.createdAt)
}

/** The id of the profile to treat as active, falling back to the first one. */
export function resolveActiveId(profiles: AccountProfile[], wanted: string): string {
  if (profiles.some((profile) => profile.id === wanted)) return wanted
  return profiles[0]?.id ?? ''
}

/* ------------------------------------------------------------------ *
 * External credential tools
 * ------------------------------------------------------------------ */

// The inner group is non-capturing on purpose: with `([0-9a-fA-F]{2})+` the
// capture would only hold the *last* pair, silently truncating the payload.
const HEX = /^(?:0x)?((?:[0-9a-fA-F]{2})+)$/

/**
 * Decodes what `security find-generic-password -w` printed.
 *
 * The tool writes the raw bytes when they are printable and a hex rendering
 * otherwise, and heap garbage is indistinguishable from either at a glance - so
 * the output is only accepted when it actually parses as an account record.
 * Guessing here would mean writing corrupt credentials into a user's Keychain.
 */
export function decodeSecurityOutput(stdout: string): string | null {
  const trimmed = stdout.replace(/\r?\n$/, '')
  if (trimmed === '') return null
  if (parseAccountRecord(trimmed)) return trimmed

  const digits = HEX.exec(trimmed.trim())?.[1]
  const decoded = digits ? decodeHex(digits) : null
  return decoded !== null && parseAccountRecord(decoded) ? decoded : null
}

/**
 * Hex → UTF-8 without `Buffer`, because this module is also typechecked (and
 * bundled) for the sandboxed renderer, where Node globals do not exist.
 */
function decodeHex(digits: string): string | null {
  try {
    const bytes = new Uint8Array(digits.length / 2)
    for (let i = 0; i < bytes.length; i += 1) {
      const byte = Number.parseInt(digits.slice(i * 2, i * 2 + 2), 16)
      if (!Number.isFinite(byte)) return null
      bytes[i] = byte
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

/**
 * Quotes one argument for `security -i`.
 *
 * The interactive interpreter parses each stdin line with a double-quote aware
 * tokeniser, so secrets never have to appear in `argv` (where every local user
 * can read them out of the process table). Backslash is escaped first: the
 * payload is JSON, whose own escapes must survive verbatim.
 */
export function securityInteractiveCommand(args: string[]): string {
  const quoted = args.map((arg) => `"${arg.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
  return quoted.join(' ')
}

/** Arguments for reading the shared slot with the macOS `security` tool. */
export function securityReadArgs(): string[] {
  return [
    'find-generic-password',
    '-s',
    IPATOOL_KEYCHAIN_SERVICE,
    '-a',
    IPATOOL_KEYCHAIN_KEY,
    '-w'
  ]
}

/**
 * Command fed to `security -i` to (re)write the shared slot.
 *
 * `-U` updates the existing item in place, which is what keeps ipatool's own
 * `Set` semantics (AddItem, then UpdateItem on duplicate) intact. `-A` grants
 * every application access instead of binding the ACL to whoever wrote the item
 * last: without it the item written by the GUI would make the *next* `ipatool`
 * run prompt for Keychain authorisation, turning account switching into a modal
 * dialog the user cannot answer from inside the app.
 */
export function securityWriteCommand(data: string): string {
  return securityInteractiveCommand([
    'add-generic-password',
    '-U',
    '-A',
    '-s',
    IPATOOL_KEYCHAIN_SERVICE,
    '-a',
    IPATOOL_KEYCHAIN_KEY,
    '-w',
    data
  ])
}

/** `secret-tool lookup service <svc> account <key>` - attributes-only match. */
export function secretToolReadArgs(): string[] {
  return ['lookup', 'service', IPATOOL_KEYCHAIN_SERVICE, 'account', IPATOOL_KEYCHAIN_KEY]
}

/** `secret-tool store` reads the secret from stdin, never from argv. */
export function secretToolWriteArgs(): string[] {
  return [
    'store',
    '--label',
    IPATOOL_KEYCHAIN_SERVICE,
    'service',
    IPATOOL_KEYCHAIN_SERVICE,
    'account',
    IPATOOL_KEYCHAIN_KEY
  ]
}

/** `secret-tool lookup` terminates the secret with a single newline. */
export function decodeSecretToolOutput(stdout: string): string | null {
  const trimmed = stdout.replace(/\n$/, '')
  return parseAccountRecord(trimmed) ? trimmed : null
}
