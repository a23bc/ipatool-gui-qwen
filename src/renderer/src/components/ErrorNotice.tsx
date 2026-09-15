import type { ReactNode } from 'react'
import { ENGINE_ERROR_CODES } from '@shared/types'
import { IPATOOL_ERROR_CODES } from '@shared/ipatool/errors'
import { useAppStore } from '@renderer/store/app'
import { useUiStore } from '@renderer/store/ui'
import type { Key } from '@renderer/i18n'
import { Icon } from './Icon'

export interface ErrorNoticeProps {
  message: string
  /** An `IpatoolErrorCode` / `EngineErrorCode`; used to look up a translated hint. */
  hint?: string | null
  /** Prefix for hint lookup: `errors.` (default) or `engine.errors.`. */
  hintNamespace?: 'errors' | 'engine.errors'
  onRetry?: () => void
  onViewLog?: () => void
  compact?: boolean
}

/**
 * Renders an error with a translated, actionable hint.
 *
 * The main process sends a stable code rather than prose, so the text is always
 * in the user's language even though ipatool itself only speaks English.
 */
export function ErrorNotice({
  message,
  hint,
  hintNamespace = 'errors',
  onRetry,
  onViewLog,
  compact = false
}: ErrorNoticeProps): ReactNode {
  const t = useAppStore((state) => state.t)
  const setView = useUiStore((state) => state.setView)

  // `hint` arrives from IPC as an untyped string: validate it against the
  // known code union before turning it into an i18n key, so an unexpected
  // code degrades to the generic title instead of leaking a raw
  // "errors.<junk>.hint" literal into the UI.
  const knownCodes: readonly string[] =
    hintNamespace === 'errors' ? IPATOOL_ERROR_CODES : ENGINE_ERROR_CODES
  const validHint = hint && knownCodes.includes(hint) ? hint : null

  const titleKey = validHint ? `${hintNamespace}.${validHint}` : null
  const hintText = validHint ? `${hintNamespace}.${validHint}.hint` : null
  const title = titleKey ? t(titleKey as Key) : t('error.title')
  const advice = hintText ? t(hintText as Key) : null

  return (
    <div
      className={`flex items-start gap-3 rounded-lg border px-3.5 ${compact ? 'py-2.5' : 'py-3'}`}
      style={{ background: 'var(--danger-soft)', borderColor: 'transparent' }}
      role="alert"
    >
      <span className="mt-0.5 shrink-0" style={{ color: 'var(--danger)' }}>
        <Icon name="alert" size={15} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[12.5px] font-semibold" style={{ color: 'var(--danger)' }}>
          {title}
        </p>
        {message && message !== title ? (
          <p className="mt-1 break-words text-[12px] leading-relaxed dim">{message}</p>
        ) : null}
        {advice ? <p className="mt-1.5 text-[12px] leading-relaxed">{advice}</p> : null}
        {onRetry || onViewLog ? (
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            {onRetry ? (
              <button type="button" className="btn h-7" onClick={onRetry}>
                <Icon name="refresh" size={13} />
                {t('common.retry')}
              </button>
            ) : null}
            {onViewLog ? (
              <button
                type="button"
                className="btn btn-ghost h-7"
                onClick={() => {
                  onViewLog()
                  setView('activity')
                }}
              >
                {t('error.viewTask')}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}
