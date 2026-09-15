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

import { mkdir, rename as renameDir, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'
import type { Profile } from '../shared/types'
import { expandUserPath } from './paths'
import { settingsStore } from './settings'

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
  const settings = settingsStore.getInternal()
  return get(settings.activeProfileId) ?? list()[0] ?? ensureDefault()
}

function newId(): string {
  return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/** Guarantees at least one profile exists (called during settings load). */
export function ensureDefault(): Profile {
  const existing = list()
  if (existing.length > 0) return existing[0]

  const profile: Profile = {
    id: 'p-default',
    name: 'Default',
    email: '',
    // Empty stateDir => ipatool's own default location, so an existing CLI
    // session (and its login) carries over instead of being orphaned.
    stateDir: '',
    createdAt: Date.now(),
    lastUsedAt: Date.now()
  }
  settingsStore.override({
    ...settingsStore.getInternal(),
    profiles: [profile],
    activeProfileId: profile.id
  })
  return profile
}

function commit(profiles: Profile[], activeProfileId: string): void {
  settingsStore.override({ ...settingsStore.getInternal(), profiles, activeProfileId })
  void settingsStore.persistNow()
  settingsStore.emitChange()
}

export function add(name: string): Profile {
  const profile: Profile = {
    id: newId(),
    name: name.trim() || `Account ${list().length + 1}`,
    email: '',
    stateDir: '',
    createdAt: Date.now(),
    lastUsedAt: Date.now()
  }
  commit([...list(), profile], profile.id)
  return profile
}

export function rename(id: string, name: string): Profile | null {
  const profiles = list().map((profile) =>
    profile.id === id ? { ...profile, name: name.trim() || profile.name } : profile
  )
  commit(profiles, settingsStore.getInternal().activeProfileId)
  return get(id)
}

/** Stores the resolved Apple ID so the switcher can label profiles. */
export function setInfo(id: string, email: string, name: string): void {
  const profiles = list().map((profile) =>
    profile.id === id ? { ...profile, email, name: profile.name === 'Default' && name ? name : profile.name } : profile
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
  const managed = dir.startsWith(profilesRoot() + path.sep) || dir === profilesRoot()
  let removedDir = false

  if (managed) {
    try {
      await rm(path.join(profilesRoot(), profile.id), { recursive: true, force: true })
      removedDir = true
    } catch {
      removedDir = false
    }
  }

  const remaining = list().filter((p) => p.id !== id)
  const finalProfiles = remaining.length > 0 ? remaining : [ensureDefaultAfterWipe()]
  const activeId = settingsStore.getInternal().activeProfileId === id ? finalProfiles[0].id : settingsStore.getInternal().activeProfileId
  commit(finalProfiles, activeId)
  return { removedDir, path: managed ? dir : null }
}

function ensureDefaultAfterWipe(): Profile {
  return {
    id: newId(),
    name: 'Default',
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
export async function migrateLegacyState(): Promise<string | null> {
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
  // Never clobber an existing session.
  if (await exists(target)) return null

  await mkdir(path.dirname(target), { recursive: true }).catch(() => {})
  try {
    await renameDir(legacy, target)
    return target
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
