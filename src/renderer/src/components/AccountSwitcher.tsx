/**
 * Header account switcher.
 *
 * Why a switcher rather than a plain "signed in as …" button: several App Store
 * sessions can coexist, and every ipatool command - search, purchase, download -
 * runs as exactly one of them. Making the current one visible at all times, and
 * switchable in one click, is what keeps "which Apple ID is this download going
 * to buy under?" answerable without opening a settings page.
 */

import { memo, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { AccountView } from '@shared/types'
import { useAppStore } from '@renderer/store/app'
import { useUiStore } from '@renderer/store/ui'
import { Icon, Spinner } from './Icon'

/** Small status dot: green when verified, amber when something needs attention. */
function StatusDot({ view }: { view: AccountView }): ReactNode {
  const tone = view.conflict ? 'var(--danger)' : view.signedIn ? 'var(--success)' : 'var(--text-faint)'
  return <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: tone }} />
}

function AccountRow({ view, onPick }: { view: AccountView; onPick: (id: string) => void }): ReactNode {
  const t = useAppStore((state) => state.t)
  const label = view.name || view.email || t('accounts.unnamed')

  return (
    <button
      type="button"
      className="row w-full gap-2 px-2.5 py-2 text-left"
      style={view.active ? { background: 'var(--row-selected)' } : undefined}
      onClick={() => onPick(view.id)}
      title={view.email || label}
    >
      <StatusDot view={view} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] font-medium">{label}</span>
        <span className="mono block truncate text-[11px] faint">
          {view.signedIn ? view.email : t('accounts.row.noSession')}
        </span>
      </span>
      {view.active ? <Icon name="check" size={13} /> : null}
    </button>
  )
}

export const AccountSwitcher = memo(function AccountSwitcher(): ReactNode {
  const t = useAppStore((state) => state.t)
  const accounts = useAppStore((state) => state.accounts)
  const account = useAppStore((state) => state.account)
  const activateAccount = useAppStore((state) => state.activateAccount)
  const addAccount = useAppStore((state) => state.addAccount)

  const setAuthOpen = useUiStore((state) => state.setAuthOpen)
  const setAccountsOpen = useUiStore((state) => state.setAccountsOpen)
  const toast = useUiStore((state) => state.toast)

  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // Close on an outside click. Listening on `mousedown` in the capture phase
  // means a click on another header control still closes the menu first, which
  // is what a menu is expected to do.
  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  const active = accounts.accounts.find((view) => view.id === accounts.activeId)

  const pick = async (id: string): Promise<void> => {
    setOpen(false)
    if (id === accounts.activeId) return
    setBusy(true)
    try {
      const result = await activateAccount(id)
      if (result.ok) {
        toast({ kind: 'success', message: t('accounts.switched') })
      } else if (result.status === 'signed-out') {
        // Switching to an account that simply has no session is a normal state,
        // not an error - offer the sign-in instead of a failure toast.
        setAuthOpen(true)
      } else {
        toast({ kind: 'warn', message: result.message || t('accounts.switchFailed') })
      }
    } finally {
      setBusy(false)
    }
  }

  const add = async (): Promise<void> => {
    setOpen(false)
    setBusy(true)
    try {
      const id = await addAccount('')
      // The slot exists from here on, but it is empty and is kept out of the
      // list, so the sign-in dialog is the only place the new account can become
      // usable. Opening it here makes "add account" one action instead of two.
      if (id) setAuthOpen(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div ref={rootRef} className="no-drag relative shrink-0">
      <button
        type="button"
        className="btn btn-ghost h-[26px] gap-1.5 px-2"
        onClick={() => setOpen((value) => !value)}
        title={account ? account.email : t('auth.signIn')}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {busy ? <Spinner size={12} /> : <Icon name="user" size={13} />}
        <span className="max-w-[160px] truncate text-[11.5px]">
          {account ? account.email : t('auth.signedOut')}
        </span>
        {active?.conflict ? (
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: 'var(--danger)' }} />
        ) : null}
        <Icon name="chevronDown" size={12} />
      </button>

      {open ? (
        <div
          className="panel fade-in absolute right-0 top-[32px] z-50 w-[300px] overflow-hidden py-1"
          style={{ boxShadow: 'var(--shadow)' }}
          role="menu"
        >
          <div className="max-h-[280px] overflow-auto">
            {accounts.accounts.length === 0 ? (
              <p className="px-2.5 py-2 text-[12px] faint">{t('accounts.empty')}</p>
            ) : (
              accounts.accounts.map((view) => (
                <AccountRow key={view.id} view={view} onPick={(id) => void pick(id)} />
              ))
            )}
          </div>

          <div className="divider my-1" />

          <button
            type="button"
            className="row w-full gap-2 px-2.5 py-2 text-left text-[12.5px]"
            onClick={() => void add()}
          >
            <Icon name="plus" size={13} />
            {t('accounts.add')}
          </button>
          <button
            type="button"
            className="row w-full gap-2 px-2.5 py-2 text-left text-[12.5px]"
            onClick={() => {
              setOpen(false)
              setAccountsOpen(true)
            }}
          >
            <Icon name="settings" size={13} />
            {t('accounts.manage')}
          </button>
        </div>
      ) : null}
    </div>
  )
})
