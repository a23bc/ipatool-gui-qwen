/**
 * Geometry and keyboard maths for the custom Select control.
 *
 * Deliberately DOM-free: these are the parts that are easy to get subtly wrong
 * (a menu that opens off-screen, an arrow key that wraps to the wrong row) and
 * impossible to check by reading JSX - while the test environment is plain node,
 * where rendering a component would drag in a whole browser stack.
 */

export interface AnchorRect {
  left: number
  right: number
  top: number
  bottom: number
  width: number
}

export interface Viewport {
  width: number
  height: number
}

export type MenuSide = 'above' | 'below'

export interface MenuPlacement {
  left: number
  top: number
  width: number
  maxHeight: number
  side: MenuSide
}

/** Distance between the trigger and the popup. */
export const MENU_GAP = 4
/** Minimum distance the popup keeps from the window edges. */
export const MENU_MARGIN = 8
/** Height of one option row (6px padding + 12.5px text + 6px padding, rounded up). */
export const MENU_ITEM_HEIGHT = 30
/** The popup's own padding, top and bottom. */
export const MENU_CHROME = 10
/** Hard cap, after which the menu scrolls. */
export const MENU_MAX_HEIGHT = 280

/** How tall the popup wants to be for `optionCount` rows. */
export function estimateMenuHeight(optionCount: number): number {
  return Math.min(MENU_MAX_HEIGHT, Math.max(0, optionCount) * MENU_ITEM_HEIGHT + MENU_CHROME)
}

/**
 * Places the popup relative to its trigger.
 *
 * Prefers opening downwards - that is what every platform's own menus do - and
 * only flips when the menu would be cut off *and* there is genuinely more room
 * above. The returned `maxHeight` is what keeps a long list (the engine-version
 * picker has up to 30 entries) scrollable instead of running off the screen.
 */
export function placeMenu(
  anchor: AnchorRect,
  viewport: Viewport,
  optionCount: number,
  minWidth = 0
): MenuPlacement {
  const width = Math.min(
    Math.max(anchor.width, minWidth),
    Math.max(0, viewport.width - MENU_MARGIN * 2)
  )
  const maxLeft = Math.max(MENU_MARGIN, viewport.width - width - MENU_MARGIN)
  const left = Math.min(Math.max(anchor.left, MENU_MARGIN), maxLeft)

  const below = viewport.height - anchor.bottom - MENU_GAP - MENU_MARGIN
  const above = anchor.top - MENU_GAP - MENU_MARGIN
  const wanted = estimateMenuHeight(optionCount)
  const side: MenuSide = wanted <= below || below >= above ? 'below' : 'above'

  const available = Math.max(0, side === 'below' ? below : above)
  const maxHeight = Math.max(1, Math.min(MENU_MAX_HEIGHT, available))
  const top =
    side === 'below'
      ? anchor.bottom + MENU_GAP
      : Math.max(MENU_MARGIN, anchor.top - MENU_GAP - Math.min(wanted, maxHeight))

  return { left, top, width, maxHeight, side }
}

/**
 * Moves the highlighted row, wrapping at both ends.
 *
 * Wrapping matters for the same reason it does in a native menu: with the menu
 * open, holding ArrowDown should not silently stop at the last entry.
 */
export function stepIndex(current: number, optionCount: number, step: 1 | -1): number {
  if (optionCount <= 0) return -1
  if (current < 0) return step > 0 ? 0 : optionCount - 1
  return (current + step + optionCount) % optionCount
}

/** Index of the first or last row, or -1 for an empty list. */
export function edgeIndex(optionCount: number, edge: 'first' | 'last'): number {
  if (optionCount <= 0) return -1
  return edge === 'first' ? 0 : optionCount - 1
}
