/**
 * Minimal semver comparison.
 *
 * A full semver library is overkill here: we only ever compare our own version
 * against the newest GitHub release tag. Pre-release suffixes are handled just
 * enough to never treat `2.7.0-rc1` as newer than `2.7.0`.
 */

export interface Semver {
  major: number
  minor: number
  patch: number
  prerelease: string[]
}

export function parseSemver(input: string): Semver | null {
  const match = input.trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)(?:[-.](.+))?$/)
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(/[.-]/) : []
  }
}

function comparePrerelease(a: string[], b: string[]): number {
  // No pre-release outranks any pre-release: 1.0.0 > 1.0.0-rc1.
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1

  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i += 1) {
    const left = a[i]
    const right = b[i]
    if (left === undefined) return -1
    if (right === undefined) return 1
    const leftNum = /^\d+$/.test(left) ? Number(left) : null
    const rightNum = /^\d+$/.test(right) ? Number(right) : null
    if (leftNum !== null && rightNum !== null) {
      if (leftNum !== rightNum) return leftNum < rightNum ? -1 : 1
    } else if (leftNum !== null) {
      return -1 // numeric identifiers sort before alphanumeric ones
    } else if (rightNum !== null) {
      return 1
    } else if (left !== right) {
      return left < right ? -1 : 1
    }
  }
  return 0
}

/** Returns -1, 0 or 1 like a comparator. Unparseable input sorts last. */
export function compareSemver(a: string, b: string): number {
  const left = parseSemver(a)
  const right = parseSemver(b)
  if (!left && !right) return 0
  if (!left) return -1
  if (!right) return 1

  if (left.major !== right.major) return left.major < right.major ? -1 : 1
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1
  return comparePrerelease(left.prerelease, right.prerelease)
}

export function isNewer(candidate: string, current: string): boolean {
  return compareSemver(candidate, current) > 0
}
