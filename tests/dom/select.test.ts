/**
 * Placement and keyboard maths behind the Select control (components/Select.tsx).
 *
 * These are the parts of a custom dropdown that fail in ways a screenshot does
 * not reveal: a menu that opens past the bottom edge, one that runs off the side
 * of the window with a long option label, or an arrow key that stops dead at the
 * last row. The component itself is thin glue around them.
 */

import { describe, expect, it } from 'vitest'
import {
  MENU_GAP,
  MENU_MARGIN,
  MENU_MAX_HEIGHT,
  edgeIndex,
  estimateMenuHeight,
  placeMenu,
  stepIndex,
  type AnchorRect,
  type Viewport
} from '@renderer/lib/select'

/** A 30px trigger in the middle of a 1280x800 window. */
function anchor(overrides: Partial<AnchorRect> = {}): AnchorRect {
  const left = overrides.left ?? 500
  const width = overrides.width ?? 190
  const top = overrides.top ?? 400
  return { left, right: left + width, top, bottom: top + 30, width, ...overrides }
}

const viewport: Viewport = { width: 1280, height: 800 }

describe('estimateMenuHeight', () => {
  it('grows with the row count and then stops at the cap', () => {
    expect(estimateMenuHeight(2)).toBe(70)
    expect(estimateMenuHeight(5)).toBeLessThan(MENU_MAX_HEIGHT)
    // The engine-version picker can hold 30 releases: it has to scroll, not
    // stretch past the window.
    expect(estimateMenuHeight(30)).toBe(MENU_MAX_HEIGHT)
  })

  it('never returns a negative height for an empty list', () => {
    expect(estimateMenuHeight(0)).toBeGreaterThan(0)
    expect(estimateMenuHeight(-3)).toBeGreaterThan(0)
  })
})

describe('placeMenu', () => {
  it('opens below the trigger when there is room', () => {
    const placement = placeMenu(anchor(), viewport, 5)
    expect(placement.side).toBe('below')
    expect(placement.top).toBe(400 + 30 + MENU_GAP)
    expect(placement.maxHeight).toBeGreaterThan(estimateMenuHeight(5))
  })

  it('aligns with the trigger and keeps its width', () => {
    const placement = placeMenu(anchor(), viewport, 5)
    expect(placement.left).toBe(500)
    expect(placement.width).toBe(190)
  })

  it('flips above the trigger when the menu would not fit below', () => {
    // 30px trigger 20px above the bottom edge, 10 options (310px wanted).
    const placement = placeMenu(anchor({ top: 750 }), viewport, 10)
    expect(placement.side).toBe('above')
    // Its bottom edge sits just above the trigger, so the list grows upwards.
    expect(placement.top + placement.maxHeight).toBeLessThanOrEqual(750 - MENU_GAP + 0.001)
    expect(placement.top).toBeGreaterThanOrEqual(MENU_MARGIN)
  })

  it('stays below when neither side has room, rather than jumping about', () => {
    // A tiny window: below is 60px, above is 20px - the larger side wins.
    const placement = placeMenu(anchor({ top: 40 }), { width: 400, height: 110 }, 8)
    expect(placement.side).toBe('below')
    expect(placement.maxHeight).toBeLessThan(estimateMenuHeight(8))
  })

  it('caps the height so a long list scrolls instead of overflowing', () => {
    const placement = placeMenu(anchor({ top: 100 }), viewport, 30)
    expect(placement.maxHeight).toBeLessThanOrEqual(MENU_MAX_HEIGHT)
    expect(placement.top + placement.maxHeight).toBeLessThanOrEqual(viewport.height - MENU_MARGIN)
  })

  it('honours a minimum width but never exceeds the viewport', () => {
    const narrow = placeMenu(anchor({ left: 10, width: 40 }), viewport, 3, 190)
    expect(narrow.width).toBe(190)
    expect(narrow.left).toBe(10)

    // A 400px floor in a 320px window cannot be honoured without leaving the
    // screen, so the width is pulled back to what the viewport allows.
    const tight = placeMenu(anchor({ left: 0, width: 40 }), { width: 320, height: 600 }, 3, 400)
    expect(tight.width).toBe(320 - MENU_MARGIN * 2)
    expect(tight.left).toBe(MENU_MARGIN)
  })

  it('pulls a right-aligned menu back inside the window', () => {
    const placement = placeMenu(anchor({ left: 1240, width: 190 }), viewport, 4)
    expect(placement.left + placement.width).toBeLessThanOrEqual(viewport.width - MENU_MARGIN)
  })
})

describe('stepIndex', () => {
  it('opens on the first row when nothing is highlighted yet', () => {
    expect(stepIndex(-1, 5, 1)).toBe(0)
    // Opening upwards starts from the last row, like a native menu.
    expect(stepIndex(-1, 5, -1)).toBe(4)
  })

  it('wraps at both ends', () => {
    expect(stepIndex(4, 5, 1)).toBe(0)
    expect(stepIndex(0, 5, -1)).toBe(4)
    expect(stepIndex(1, 5, 1)).toBe(2)
  })

  it('reports no row for an empty list', () => {
    expect(stepIndex(-1, 0, 1)).toBe(-1)
    expect(stepIndex(0, 0, -1)).toBe(-1)
  })
})

describe('edgeIndex', () => {
  it('points at the first and last row', () => {
    expect(edgeIndex(6, 'first')).toBe(0)
    expect(edgeIndex(6, 'last')).toBe(5)
  })

  it('reports no row for an empty list', () => {
    expect(edgeIndex(0, 'first')).toBe(-1)
    expect(edgeIndex(0, 'last')).toBe(-1)
  })
})
