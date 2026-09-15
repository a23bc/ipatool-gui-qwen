import type { ProfileView } from './ipc'

/**
 * Pure helpers for profile views.
 *
 * Kept free of any store/electron imports so the defensive coercion below is
 * unit-testable: an IPC shape mismatch must degrade to "no profiles", never
 * crash the renderer (a previous crash of exactly that kind blanked the window).
 */

export function asProfileViews(value: unknown): ProfileView[] {
  return Array.isArray(value) ? (value as ProfileView[]) : []
}

export function activeProfile(profiles: ProfileView[]): ProfileView | null {
  return profiles.find((profile) => profile.active) ?? profiles[0] ?? null
}
