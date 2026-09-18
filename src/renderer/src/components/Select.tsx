/**
 * The app's select control - every `<select>` in the UI is one of these.
 *
 * A native `<select>` is the one control that cannot be themed: the box takes
 * CSS, but the popup is drawn by the OS (Windows' grey list, the system font,
 * its own hover highlight), so it sat next to the app's own menus looking like
 * it came from a different program. Every other menu here - the account
 * switcher, the command palette - is a themed panel, so this is too.
 *
 * Two mechanics worth knowing before editing:
 *
 * - The popup is portalled to `<body>` and positioned `fixed`. These controls
 *   live inside cards with `overflow: hidden` (SettingsView's `Section`) and
 *   inside toolbars, where an absolutely positioned menu would be clipped. The
 *   placement maths lives in lib/select.ts.
 * - Focus never moves off the trigger. The listbox is rendered somewhere else in
 *   the DOM, so the trigger keeps the keyboard, reports the active row through
 *   `aria-activedescendant`, and the rows only ever react to the mouse.
 */

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { edgeIndex, placeMenu, stepIndex, type MenuPlacement } from '@renderer/lib/select'
import { Icon } from './Icon'

export interface SelectOption<T extends string | number> {
  value: T
  label: string
}

export interface SelectProps<T extends string | number> {
  value: T
  options: SelectOption<T>[]
  onChange: (value: T) => void
  /**
   * Layout only - widths and `no-drag`. The box itself comes from
   * `.select-trigger`; a height utility here would be ignored anyway, because
   * index.css is unlayered and therefore beats Tailwind's utility layer.
   */
  className?: string
  id?: string
  ariaLabel?: string
  title?: string
  disabled?: boolean
  /** Popup width floor in px; the trigger's own width wins when it is wider. */
  menuMinWidth?: number
}

export function Select<T extends string | number>({
  value,
  options,
  onChange,
  className = '',
  id,
  ariaLabel,
  title,
  disabled = false,
  menuMinWidth = 0
}: SelectProps<T>): ReactNode {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const [placement, setPlacement] = useState<MenuPlacement | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const listId = useId()

  const selected = options.findIndex((option) => option.value === value)

  const reposition = useCallback(() => {
    const trigger = triggerRef.current
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    setPlacement(
      placeMenu(
        {
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
          width: rect.width
        },
        { width: window.innerWidth, height: window.innerHeight },
        options.length,
        menuMinWidth
      )
    )
  }, [menuMinWidth, options.length])

  // A layout effect, so the popup is measured and placed before it paints: with
  // a plain effect it flashes at the top-left corner of the window first.
  useLayoutEffect(() => {
    if (open) reposition()
  }, [open, reposition])

  const close = useCallback((): void => {
    setOpen(false)
    setActive(-1)
  }, [])

  useEffect(() => {
    if (!open) return

    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target as Node | null
      if (!target) return
      // The trigger is included so its own click handler (which toggles) wins.
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return
      close()
    }
    // A menu pinned to a moving anchor is worse than no menu, so anything that
    // moves the trigger dismisses it - which is also what a native popup does.
    // Scrolling *inside* the menu is the one exception.
    const onScroll = (event: Event): void => {
      const target = event.target
      if (target instanceof Node && menuRef.current?.contains(target)) return
      close()
    }

    document.addEventListener('mousedown', onPointerDown, true)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', close)
    }
  }, [open, close])

  // Keeps the highlighted row in view while arrowing through a scrolling list.
  useEffect(() => {
    if (!open || active < 0) return
    const menu = menuRef.current
    menu?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [open, active])

  const openMenu = (): void => {
    setActive(selected >= 0 ? selected : edgeIndex(options.length, 'first'))
    setOpen(true)
  }

  const commit = (next: SelectOption<T>): void => {
    close()
    triggerRef.current?.focus()
    if (next.value !== value) onChange(next.value)
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    if (disabled) return

    if (!open) {
      // Enter/Space open the listbox and hand the arrow keys to it, so the
      // trigger needs no separate "commit" path for the closed state.
      const opens =
        event.key === 'ArrowDown' ||
        event.key === 'ArrowUp' ||
        event.key === 'Enter' ||
        event.key === ' '
      if (opens) {
        event.preventDefault()
        openMenu()
      }
      return
    }

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        setActive((index) => stepIndex(index, options.length, 1))
        break
      case 'ArrowUp':
        event.preventDefault()
        setActive((index) => stepIndex(index, options.length, -1))
        break
      case 'Home':
        event.preventDefault()
        setActive(edgeIndex(options.length, 'first'))
        break
      case 'End':
        event.preventDefault()
        setActive(edgeIndex(options.length, 'last'))
        break
      case 'Enter':
      case ' ': {
        event.preventDefault()
        const option = options[active]
        if (option) commit(option)
        break
      }
      case 'Escape':
        event.preventDefault()
        close()
        break
      case 'Tab':
        // Leaving the control should not leave a menu behind.
        close()
        break
      default:
        break
    }
  }

  const current = options.find((option) => option.value === value)

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        id={id}
        className={`select-trigger ${className}`}
        disabled={disabled}
        title={title}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
        aria-label={ariaLabel}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={onKeyDown}
      >
        <span className="select-value">{current?.label ?? ''}</span>
        <Icon name="chevronDown" size={12} className="select-caret" />
      </button>

      {open && placement
        ? createPortal(
            <div
              ref={menuRef}
              id={listId}
              role="listbox"
              aria-label={ariaLabel}
              className="panel select-menu fade-in"
              style={{
                left: placement.left,
                top: placement.top,
                width: placement.width,
                maxHeight: placement.maxHeight,
                boxShadow: 'var(--shadow)'
              }}
            >
              {options.map((option, index) => (
                <button
                  key={String(option.value)}
                  type="button"
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={option.value === value}
                  data-active={index === active ? 'true' : undefined}
                  className="select-option"
                  onMouseEnter={() => setActive(index)}
                  // Never let the row take focus: key handling lives on the
                  // trigger, and a modal's focus trap must not see focus escape
                  // into a portal.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => commit(option)}
                >
                  <span className="select-value">{option.label}</span>
                  {option.value === value ? <Icon name="check" size={13} /> : null}
                </button>
              ))}
            </div>,
            document.body
          )
        : null}
    </>
  )
}
