import { describe, expect, it } from 'vitest'
import { activeProfile, asProfileViews } from '@shared/profiles'
import type { ProfileView } from '@shared/ipc'

function view(id: string, active: boolean): ProfileView {
  return {
    id,
    name: id,
    remark: '',
    email: '',
    stateDir: '',
    createdAt: 0,
    lastUsedAt: 0,
    active,
    dir: `/tmp/${id}`,
    hasPassword: false
  }
}

describe('asProfileViews', () => {
  it('passes arrays through untouched', () => {
    const list = [view('a', true)]
    expect(asProfileViews(list)).toBe(list)
  })

  // Regression: a handler once returned { profiles, addedId }; the renderer must
  // survive that (and any other drift) with an empty list instead of throwing.
  it.each([
    ['object', { profiles: [], addedId: 'x' }],
    ['null', null],
    ['undefined', undefined],
    ['string', 'nope'],
    ['number', 42]
  ])('degrades %s to an empty list', (_label, value) => {
    expect(asProfileViews(value)).toEqual([])
  })
})

describe('activeProfile', () => {
  it('prefers the flagged profile', () => {
    const list = [view('a', false), view('b', true)]
    expect(activeProfile(list)?.id).toBe('b')
  })

  it('falls back to the first entry and to null', () => {
    expect(activeProfile([view('a', false)])?.id).toBe('a')
    expect(activeProfile([])).toBeNull()
  })
})
