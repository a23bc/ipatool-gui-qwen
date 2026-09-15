import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { Icon } from './Icon'

export interface ModalProps {
  open: boolean
  title: string
  subtitle?: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  /** Width in pixels; defaults to a comfortable 460. */
  width?: number
}

/**
 * Accessible modal: Escape closes, focus moves into the panel on open and is
 * trapped with a simple first/last-element cycle.
 */
export function Modal({
  open,
  title,
  subtitle,
  onClose,
  children,
  footer,
  width = 460
}: ModalProps): ReactNode {
  const panelRef = useRef<HTMLDivElement>(null)

  // Callers pass a fresh arrow function every render; keeping it in a ref lets
  // the focus/trap effect depend on `open` alone. Depending on the prop made the
  // effect re-run on every keystroke of a controlled input inside the dialog,
  // which yanked focus onto the header's close button each time.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    if (!open) return

    const previous = document.activeElement as HTMLElement | null
    const panel = panelRef.current

    // Focus the first *field*, never dialog chrome: the header close button
    // precedes the body in DOM order, so a generic "first focusable" query
    // would target it instead of the input the user is meant to type in.
    const focusTarget =
      panel?.querySelector<HTMLElement>('input:not([type=hidden]), textarea, select') ??
      panel?.querySelector<HTMLElement>('footer button') ??
      panel
    focusTarget?.focus()

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab' || !panel) return
      const focusables = panel.querySelectorAll<HTMLElement>(
        'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
      )
      if (focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      previous?.focus?.()
    }
    // Deliberately only `open`: this must run once per open, not per render.
  }, [open])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(2px)' }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="panel fade-in flex max-h-full flex-col overflow-hidden"
        style={{ width, boxShadow: 'var(--shadow)' }}
      >
        <header className="flex items-start justify-between gap-4 border-b px-5 py-4" style={{ borderColor: 'var(--border)' }}>
          <div className="min-w-0">
            <h2 className="truncate text-[15px] font-semibold">{title}</h2>
            {subtitle ? <p className="mt-1 text-xs dim">{subtitle}</p> : null}
          </div>
          <button type="button" className="btn btn-ghost btn-icon no-drag" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-auto px-5 py-4">{children}</div>

        {footer ? (
          <footer
            className="flex items-center justify-end gap-2 border-t px-5 py-3"
            style={{ borderColor: 'var(--border)' }}
          >
            {footer}
          </footer>
        ) : null}
      </div>
    </div>
  )
}
