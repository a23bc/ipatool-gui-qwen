import type { ReactNode } from 'react'
import { Icon, type IconName } from './Icon'

export interface EmptyStateProps {
  icon?: IconName
  title: string
  body?: string
  children?: ReactNode
  /** Extra items rendered as a bulleted hint list. */
  tips?: string[]
}

export function EmptyState({ icon = 'box', title, body, children, tips }: EmptyStateProps): ReactNode {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-8 py-14 text-center">
      <span
        className="flex h-12 w-12 items-center justify-center rounded-2xl"
        style={{ background: 'var(--panel-2)', color: 'var(--text-faint)' }}
      >
        <Icon name={icon} size={22} strokeWidth={1.5} />
      </span>
      <h3 className="text-[15px] font-semibold">{title}</h3>
      {body ? <p className="max-w-[46ch] text-[12.5px] leading-relaxed dim">{body}</p> : null}
      {tips && tips.length > 0 ? (
        <ul className="mt-1 flex max-w-[52ch] flex-col gap-1.5 text-left text-[12px] dim">
          {tips.map((tip) => (
            <li key={tip} className="flex gap-2">
              <span style={{ color: 'var(--text-faint)' }}>·</span>
              <span>{tip}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {children ? <div className="mt-2 flex items-center gap-2">{children}</div> : null}
    </div>
  )
}
