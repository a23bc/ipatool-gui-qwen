/**
 * Verifying and switching the App Store session.
 *
 * The account registry (main/accounts.ts) decides *where* a session lives; this
 * module asks ipatool what is actually in there and reacts to the answer. The
 * distinction matters because upstream offers no "who am I" shortcut that cannot
 * lie: `cmd/auth.go`'s `info` reads the keyring record, while every store command
 * authenticates with the cookies in the state directory. The two can disagree -
 * that is exactly the shared-slot situation - so the only trustworthy check is a
 * functional one: run `auth info` under the account's own environment and compare
 * the identity it reports with the one we recorded.
 *
 * Nothing here ever guesses. An unverifiable session is reported as such, because
 * acting as the wrong Apple ID is a far worse outcome than an honest failure: a
 * `download --purchase` under the wrong account buys on the wrong account.
 */

import type { AccountInfo, AccountsSnapshot } from '../shared/types'
import { AccountError, accounts } from './accounts'
import { ApiError, ipatoolApi } from './api'

export type SessionStatus =
  /** The account's own session answered and matches what we recorded. */
  | 'ok'
  /** No session in this account's directory - it needs a sign-in. */
  | 'signed-out'
  /** A session answered, but it belongs to a different Apple ID. */
  | 'foreign'
  /** The check itself could not run (engine missing, network down, ...). */
  | 'unavailable'

export interface SessionCheck {
  status: SessionStatus
  /** Identity the session reported, when there was one. */
  account: AccountInfo | null
  /** E-mail the account is expected to be, for the mismatch message. */
  expected: string
  message: string
}

/**
 * Runs the identity probe for one account and records what it learned.
 *
 * A successful probe is also how an account created outside the GUI (the terminal
 * CLI, or a session that survived a reinstall) is adopted: the first `auth info`
 * that answers teaches us the e-mail, which is what all later checks compare
 * against.
 */
export async function verifySession(accountId: string): Promise<SessionCheck> {
  const profile = accounts.get(accountId)
  if (!profile) {
    throw new AccountError('That account no longer exists', 'profile-not-found')
  }

  const expected = profile.email.trim()
  let info: AccountInfo
  try {
    info = await ipatoolApi.accountInfo(accountId)
  } catch (error) {
    if (error instanceof ApiError && error.code === 'not-signed-in') {
      return { status: 'signed-out', account: null, expected, message: 'No session is stored for this account.' }
    }
    // Anything else (engine missing, network down, bad passphrase) is reported as
    // unverifiable rather than as "signed out": they need different fixes, and
    // conflating them once sent users to re-enter a password they already had.
    accounts.setConflict(accountId, null)
    return {
      status: 'unavailable',
      account: null,
      expected,
      message: error instanceof Error ? error.message : String(error)
    }
  }

  const reported = info.email.trim()
  if (expected !== '' && reported !== '' && reported.toLowerCase() !== expected.toLowerCase()) {
    // The directory answered as somebody else. Reported, never "fixed" silently:
    // on a shared credential slot it usually means another tool signed in on this
    // machine, and the user has to know that their download would have run - or
    // purchased - as that other account.
    accounts.setConflict(accountId, 'foreign-session')
    return {
      status: 'foreign',
      account: info,
      expected,
      message: `This account's session currently belongs to ${reported}.`
    }
  }

  accounts.markIdentity(accountId, { email: reported || expected, dsid: profile.dsid, name: info.name })
  accounts.setConflict(accountId, null)
  return { status: 'ok', account: info, expected: reported || expected, message: '' }
}

/**
 * Switches the active account and reports whether it is actually usable.
 *
 * Switching itself is cheap - the session is selected by the environment every
 * invocation uses - so this deliberately does not re-authenticate. It verifies,
 * because a switch that silently lands on a dead or foreign session is worse than
 * no switch at all.
 */
export async function switchTo(accountId: string): Promise<{ snapshot: AccountsSnapshot; check: SessionCheck }> {
  const profile = accounts.activate(accountId)
  if (!profile) {
    throw new AccountError('That account no longer exists', 'profile-not-found')
  }
  const check = await verifySession(profile.id)
  return { snapshot: await accounts.snapshot(), check }
}

/**
 * Re-probes every account, cheapest-first.
 *
 * Used when the accounts panel opens: it is the only way to tell "signed in" from
 * "we remember an e-mail but the Apple session is gone", and it is what fills in
 * the identity of accounts that were logged in by the CLI.
 */
export async function refreshAll(onlyUnknown = false): Promise<AccountsSnapshot> {
  for (const profile of accounts.list()) {
    if (onlyUnknown && accounts.hasRecordedSession(profile)) continue
    try {
      await verifySession(profile.id)
    } catch {
      // A single unreachable account must not stop the sweep; its conflict flag
      // (or its unchanged state) already describes it.
    }
  }
  return accounts.snapshot()
}

/**
 * Post-login bookkeeping.
 *
 * `cmd/auth.go` writes the account record into the keyring and tells us nothing
 * about where it went, so the store is probed rather than assumed. When it turns
 * out to be the machine-wide slot, a verbatim copy is saved so that switching back
 * to this account later needs no password; when it is the per-directory file the
 * account is already self-contained and nothing is copied.
 */
export async function afterLogin(accountId: string, info: AccountInfo): Promise<AccountsSnapshot> {
  const profile = accounts.get(accountId)
  if (!profile) throw new AccountError('That account no longer exists', 'profile-not-found')

  let dsid = profile.dsid
  if ((await accounts.resolveCredentialStore(profile)) === 'os') {
    if (await accounts.captureSlotIdentity(profile)) {
      // The raw record carries the DirectoryServicesID, which `auth info` does
      // not expose; keeping it makes later identity checks exact rather than
      // e-mail-only.
      const saved = await accounts.readSnapshot(profile)
      const dsidFromRecord = saved ? readDirectoryServicesId(saved) : ''
      if (dsidFromRecord !== '') dsid = dsidFromRecord
    } else {
      // The account is usable right now, but switching away and back will need a
      // password again - surfaced instead of discovered later.
      accounts.setConflict(accountId, 'unreadable-slot')
    }
  }

  accounts.markIdentity(accountId, { email: info.email, dsid, name: info.name })
  return accounts.snapshot()
}

/** Pulls the DirectoryServicesID out of a raw record; '' when it is not there. */
function readDirectoryServicesId(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { directoryServicesIdentifier?: unknown }
    return typeof parsed.directoryServicesIdentifier === 'string' ? parsed.directoryServicesIdentifier : ''
  } catch {
    return ''
  }
}
