import type { ReactNode } from 'react'
import { useUiStore } from '@renderer/store/ui'
import { Icon, type IconName } from './Icon'

const KIND_ICON: Record<string, IconName> = {
  info: 'info',
  success: 'checkCircle',
  warn: 'alert',
  error: 'xCircle'
}

const KIND_CLASS: Record<string, string> = {
  info: 'badge-accent',
  success: 'badge-success',
  warn: 'badge-warn',
  error: 'badge-danger'
}

/** Bottom-right notification stack. Auto-dismissal is handled by the store. */
export function Toasts(): ReactNode {
  const toasts = useUiStore((state) => state.toasts)
  const dismiss = useUiStore((state) => state.dismissToast)

  if (toasts.length === 0) return null

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[340px] flex-col gap-2">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className="toast-in panel pointer-events-auto flex items-start gap-2.5 px-3.5 py-3"
          style={{ boxShadow: 'var(--shadow)' }}
          role="status"
        >
          <span className={`badge mt-0.5 shrink-0 ${KIND_CLASS[toast.kind] ?? ''}`}>
            <Icon name={KIND_ICON[toast.kind] ?? 'info'} size={11} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[12.5px] font-medium leading-snug">{toast.message}</p>
            {toast.detail ? (
              <p className="mt-1 line-clamp-3 text-[11.5px] leading-snug dim">{toast.detail}</p>
            ) : null}
            {toast.actionLabel ? (
              <button
                type="button"
                className="btn btn-ghost mt-1.5 h-6 px-2 text-[11.5px]"
                onClick={() => {
                  toast.onAction?.()
                  dismiss(toast.id)
                }}
              >
                {toast.actionLabel}
              </button>
            ) : null}
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-icon h-6 w-6 shrink-0"
            onClick={() => dismiss(toast.id)}
            aria-label="Dismiss"
          >
            <Icon name="x" size={12} />
          </button>
        </div>
      ))}
    </div>
  )
}
