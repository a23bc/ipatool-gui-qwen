import { describe, expect, it } from 'vitest'
import { compareSemver, isNewer, parseSemver } from '@shared/semver'

describe('parseSemver', () => {
  it('parses plain semver', () => {
    expect(parseSemver('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] })
  })

  it('strips a leading v (any case)', () => {
    expect(parseSemver('v2.0.0')?.major).toBe(2)
    expect(parseSemver('V2.0.1')?.patch).toBe(1)
  })

  it('parses dash prereleases', () => {
    expect(parseSemver('1.0.0-rc1')?.prerelease).toEqual(['rc1'])
  })

  it('parses dotted prereleases', () => {
    expect(parseSemver('1.0.0-rc.1')?.prerelease).toEqual(['rc', '1'])
  })

  it('parses a four-component tag as patch + prerelease (legacy dot separator)', () => {
    expect(parseSemver('1.2.3.4')?.prerelease).toEqual(['4'])
  })

  it('parses build metadata without breaking precedence', () => {
    expect(parseSemver('1.0.0+build.42')).toEqual({ major: 1, minor: 0, patch: 0, prerelease: [] })
    expect(parseSemver('1.0.0-rc1+build.42')?.prerelease).toEqual(['rc1'])
  })

  it('trims surrounding whitespace', () => {
    expect(parseSemver('  1.2.3  ')).not.toBeNull()
  })

  it('rejects garbage', () => {
    expect(parseSemver('not-a-version')).toBeNull()
    expect(parseSemver('1.2')).toBeNull()
    expect(parseSemver('')).toBeNull()
    expect(parseSemver('1.2.x')).toBeNull()
  })

  it('tolerates extra dot-separated components as prerelease identifiers', () => {
    // Some vendors tag four-component versions; they parse, and compare below
    // the same x.y.z release (prerelease semantics), which is the safe order.
    expect(parseSemver('1.2.3.4.5')?.prerelease).toEqual(['4', '5'])
  })
})

describe('compareSemver', () => {
  it('orders by major/minor/patch', () => {
    expect(compareSemver('2.0.0', '1.9.9')).toBe(1)
    expect(compareSemver('1.2.0', '1.10.0')).toBe(-1)
    expect(compareSemver('1.2.3', '1.2.4')).toBe(-1)
  })

  it('orders prerelease below release', () => {
    expect(compareSemver('1.0.0-rc1', '1.0.0')).toBe(-1)
    expect(compareSemver('1.0.0', '1.0.0-rc1')).toBe(1)
  })

  it('numeric prerelease identifiers sort before alphanumeric ones', () => {
    expect(compareSemver('1.0.0-1', '1.0.0-alpha')).toBe(-1)
    expect(compareSemver('1.0.0-alpha', '1.0.0-1')).toBe(1)
  })

  it('compares pure-numeric identifiers numerically and alphanumeric ones by ASCII (semver spec)', () => {
    expect(compareSemver('1.0.0-2', '1.0.0-10')).toBe(-1)
    // 'rc2' and 'rc10' are alphanumeric: per spec they sort in ASCII order,
    // so rc2 comes AFTER rc10 - pinned here so the behaviour stays deliberate.
    expect(compareSemver('1.0.0-rc2', '1.0.0-rc10')).toBe(1)
  })

  it('a shorter prerelease prefix sorts first', () => {
    expect(compareSemver('1.0.0-rc', '1.0.0-rc.1')).toBe(-1)
  })

  it('returns 0 for equal versions', () => {
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0)
    expect(compareSemver('v1.2.3', '1.2.3')).toBe(0)
  })

  it('treats build metadata as equal (semver precedence rule)', () => {
    expect(compareSemver('1.0.0+build1', '1.0.0+build2')).toBe(0)
    expect(compareSemver('1.0.0+build1', '1.0.0')).toBe(0)
  })

  it('unparseable input sorts last', () => {
    expect(compareSemver('garbage', '1.0.0')).toBe(-1)
    expect(compareSemver('1.0.0', 'garbage')).toBe(1)
    expect(compareSemver('garbage', 'nonsense')).toBe(0)
  })
})

describe('isNewer', () => {
  it('returns true when the candidate is newer', () => {
    expect(isNewer('1.2.0', '1.1.0')).toBe(true)
    expect(isNewer('1.0.0', '1.0.0-rc1')).toBe(true)
  })

  it('returns false when the candidate is older', () => {
    expect(isNewer('1.0.0', '1.1.0')).toBe(false)
    expect(isNewer('1.0.0-rc1', '1.0.0')).toBe(false)
  })

  it('returns false for equal versions (including build metadata)', () => {
    expect(isNewer('1.2.3', '1.2.3')).toBe(false)
    expect(isNewer('1.2.3+build9', '1.2.3')).toBe(false)
  })
})
