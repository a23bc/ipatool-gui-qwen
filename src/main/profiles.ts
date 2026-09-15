/**
 * Multi-account profiles.
 *
 * ipatool keeps exactly one session (keyring file + cookie jar) inside its state
 * directory, which it resolves from `XDG_STATE_HOME` / `XDG_DATA_HOME` on every
 * platform (see cmd/state_directory.go upstream). That gives us a clean,
 * upstream-sanctioned way to hold several accounts: **one state directory per
 * profile**, selected per invocation via the environment.
 *
 * Consequences worth knowing:
 *  - switching accounts needs no logout/login of the previous one;
 *  - a profile whose `stateDir` is left empty uses ipatool's default location,
 *    i.e. it shares the session with the terminal CLI (handy for migration);
 *  - queue items store the profile id they were created with, so a download
 *    never resumes under a different account after a switch.
 */

import { randomBytes } from 'node:crypto'
import { mkdir, rename as renameDir, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'
import type { Profile } from '../shared/types'
import { expandUserPath } from './paths'
import { settingsStore } from './settings'

/**
 * Synchronous mirrors of state that must never be read stale.
 *
 * `activeId` lives here (not only in settings.json) because the active profile
 * decides which session directory every ipatool invocation uses; reading it
 * through the settings object exposed us to normalization/override interleaving
 * and once sent a login into the wrong profile.
 *
 * `sessionEmail` records what ipatool's session actually reported per profile, so
 * a mismatch with the profile's recorded e-mail can be surfaced instead of
 * silently acting as the wrong account.
 */
let activeIdCache: string | null = null
const sessionEmail = new Map<string, string | null>()

/** Root for state directories this app manages itself. */
export function profilesRoot(): string {
  return path.join(app.getPath('userData'), 'profiles')
}

/**
 * The directory ipatool should use for this profile.
 *
 * A custom `stateDir` is honoured verbatim (expanded); otherwise we hand out a
 * per-profile directory under our own userData so profiles cannot collide.
 */
export function dirFor(profile: Profile): string {
  const custom = profile.stateDir.trim()
  if (custom !== '') return expandUserPath(custom)
  return path.join(profilesRoot(), profile.id, 'state')
}

/** Environment fragment that selects the profile's session. */
export function envFor(profile: Profile): Record<string, string> {
  return { XDG_STATE_HOME: dirFor(profile) }
}

export function list(): Profile[] {
  return settingsStore.getInternal().profiles
}

export function get(id: string): Profile | null {
  return list().find((profile) => profile.id === id) ?? null
}

export function active(): Profile {
  const fromCache = activeIdCache ? get(activeIdCache) : null
  if (fromCache) return fromCache
  const settings = settingsStore.getInternal()
  const profile = get(settings.activeProfileId) ?? list()[0] ?? ensureDefault()
  activeIdCache = profile.id
  return profile
}

/** Records which e-mail the profile's ipatool session actually reports. */
export function noteSessionEmail(id: string, email: string | null): void {
  sessionEmail.set(id, email)
}

export function recordedSessionEmail(id: string): string | null | undefined {
  return sessionEmail.has(id) ? (sessionEmail.get(id) as string | null) : undefined
}

function newId(): string {
  // 32 bits of CSPRNG on top of the timestamp: two profiles created in the
  // same millisecond can no longer collide.
  return `p${Date.now().toString(36)}${randomBytes(4).toString('hex')}`
}

/** Guarantees at least one profile exists (called during settings load). */
export function ensureDefault(): Profile {
  const first = list()[0]
  if (first) return first

  const profile: Profile = {
    id: 'p-default',
    name: 'Default',
    remark: '',
    email: '',
    // Empty stateDir => ipatool's own default location, so an existing CLI
    // session (and its login) carries over instead of being orphaned.
    stateDir: '',
    createdAt: Date.now(),
    lastUsedAt: Date.now()
  }
  activeIdCache = profile.id
  settingsStore.override({
    ...settingsStore.getInternal(),
    profiles: [profile],
    activeProfileId: profile.id
  })
  return profile
}

function commit(profiles: Profile[], activeProfileId: string): void {
  activeIdCache = activeProfileId
  settingsStore.override({ ...settingsStore.getInternal(), profiles, activeProfileId })
  void settingsStore.persistNow()
  settingsStore.emitChange()
}

/**
 * Creates a profile.
 *
 * The typed text becomes the optional *remark*; the identity label is a unique
 * placeholder until login replaces it with the account name/e-mail. The counter
 * is persisted, so removing profiles can never recycle a name and produce two
 * identically-labelled entries (which once made switching look like overwriting).
 */
export function add(remark: string): Profile {
  const settings = settingsStore.getInternal()
  const counter = Math.max(1, Math.round(settings.profileCounter || 1))
  const profile: Profile = {
    id: newId(),
    name: `Account ${counter}`,
    remark: remark.trim(),
    email: '',
    stateDir: '',
    createdAt: Date.now(),
    lastUsedAt: Date.now()
  }
  settingsStore.override({ ...settings, profileCounter: counter + 1 })
  commit([...list(), profile], profile.id)
  return profile
}

/** Edits the user's free-form note; the identity label stays auto-managed. */
export function setRemark(id: string, remark: string): Profile | null {
  const profiles = list().map((profile) =>
    profile.id === id ? { ...profile, remark: remark.trim() } : profile
  )
  commit(profiles, settingsStore.getInternal().activeProfileId)
  return get(id)
}

/** Kept for API compatibility; now edits the remark, not the identity label. */
export function rename(id: string, remark: string): Profile | null {
  return setRemark(id, remark)
}

/**
 * Stores the resolved Apple ID and adopts it as the identity label, so a
 * profile is recognisable at a glance without any manual naming.
 */
export function setInfo(id: string, email: string, name: string): void {
  const profiles = list().map((profile) =>
    profile.id === id
      ? { ...profile, email, name: name.trim() || email.trim() || profile.name }
      : profile
  )
  commit(profiles, settingsStore.getInternal().activeProfileId)
}

export function touch(id: string): void {
  const profiles = list().map((profile) =>
    profile.id === id ? { ...profile, lastUsedAt: Date.now() } : profile
  )
  settingsStore.override({ ...settingsStore.getInternal(), profiles })
}

export function setActive(id: string): Profile | null {
  const profile = get(id)
  if (!profile) return null
  commit(list(), id)
  return profile
}

/**
 * Deletes a profile.
 *
 * Only directories this app created (under profilesRoot) are removed from disk;
 * a profile pointing at a custom stateDir - which may be shared with the CLI or
 * with another tool - is unregistered but never deleted.
 */
export async function remove(id: string): Promise<{ removedDir: boolean; path: string | null }> {
  const profile = get(id)
  if (!profile) return { removedDir: false, path: null }

  const dir = dirFor(profile)
  // dirFor() always appends `<id>/state` for managed profiles, so a strict
  // prefix check is sufficient - the root itself can never be a profile dir.
  const managed = dir.startsWith(profilesRoot() + path.sep)
  let removedDir = false

  if (managed) {
    try {
      await rm(path.join(profilesRoot(), profile.id), { recursive: true, force: true })
      removedDir = true
    } catch {
      removedDir = false
    }
  }

  // The recorded-session mirror must not outlive the profile it describes.
  sessionEmail.delete(id)

  const remaining = list().filter((p) => p.id !== id)
  const finalProfiles = remaining.length > 0 ? remaining : [ensureDefaultAfterWipe()]
  const previousActive = settingsStore.getInternal().activeProfileId
  const activeId = previousActive === id ? (finalProfiles[0]?.id ?? previousActive) : previousActive
  commit(finalProfiles, activeId)
  return { removedDir, path: managed ? dir : null }
}

function ensureDefaultAfterWipe(): Profile {
  return {
    id: newId(),
    name: 'Default',
    remark: '',
    email: '',
    stateDir: '',
    createdAt: Date.now(),
    lastUsedAt: Date.now()
  }
}

/**
 * One-time migration of ipatool's legacy state directory (~/.ipatool).
 *
 * Upstream resolve order is dangerous for multi-account use: when the legacy
 * directory exists, ipatool falls back to it if the XDG target already exists
 * (every profile would silently share one session), or *moves* it into whatever
 * profile happens to run first. Neither is acceptable, so we perform the move
 * ourselves, exactly once, into the default profile, before ipatool ever runs.
 * After this the legacy path never exists and per-profile isolation is
 * deterministic.
 *
 * Returns the new location, or null when there was nothing to migrate.
 */
/**
 * The migration runs at most once per process: after the first call the legacy
 * directory either moved or was quarantined, so the repeat calls that used to
 * sit in two IPC handlers could only ever return null. Caching the promise
 * also de-duplicates concurrent callers (startup vs. an early profiles:add).
 */
let migrationPromise: Promise<'migrated' | 'quarantined' | null> | null = null

export function migrateLegacyState(): Promise<'migrated' | 'quarantined' | null> {
  if (!migrationPromise) {
    migrationPromise = doMigrateLegacyState().catch((error: unknown) => {
      // A failed migration may be retried on the next call.
      migrationPromise = null
      throw error
    })
  }
  return migrationPromise
}

async function doMigrateLegacyState(): Promise<'migrated' | 'quarantined' | null> {
  const legacy = path.join(os.homedir(), '.ipatool')
  const target = path.join(dirFor(ensureDefault()), 'ipatool')

  const exists = async (candidate: string): Promise<boolean> => {
    try {
      await stat(candidate)
      return true
    } catch {
      return false
    }
  }

  if (!(await exists(legacy))) return null
  await mkdir(path.dirname(target), { recursive: true }).catch(() => {})

  if (!(await exists(target))) {
    // Normal migration: adopt the legacy session as the default profile.
    try {
      await renameDir(legacy, target)
      return 'migrated'
    } catch {
      return null
    }
  }

  // Both exist. Leaving the legacy directory in place is dangerous: upstream
  // would then (a) fall back to it for every profile, or (b) move it into the
  // next profile that runs. Rename it out of ipatool's sight but keep it on
  // disk so nothing is destroyed.
  const backup = `${legacy}.ipatool-gui-backup-${Date.now().toString(36)}`
  try {
    await renameDir(legacy, backup)
    return 'quarantined'
  } catch {
    return null
  }
}

/** Creates the managed directory eagerly so ipatool never has to race us. */
export async function ensureDir(profile: Profile): Promise<string> {
  const dir = dirFor(profile)
  await mkdir(dir, { recursive: true }).catch(() => {})
  return dir
}
