/**
 * Account manager: add, switch, rename and remove App Store sessions.
 *
 * The panel deliberately explains the one platform difference that a user cannot
 * discover on their own: on Windows (and Linux) every account keeps its own
 * encrypted credential record, while macOS stores ipatool's credentials in a
 * single login-Keychain item that the app has to move between accounts. Saying so
 * - with the capability the main process actually measured - turns a confusing
 * "why did my terminal session change?" into an expectation the UI already set.
 */

import { memo, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { AccountView } from '@shared/types'
import { useAppStore } from '@renderer/store/app'
import { useUiStore } from '@renderer/store/ui'
import { Icon, Spinner } from './Icon'
import { Modal } from './Modal'

function CredentialBadge({ view }: { view: AccountView }): ReactNode {
  const t = useAppStore((state) => state.t)
  if (view.credentialStore === 'file') {
    return <span className="badge badge-success">{t('accounts.store.file')}</span>
  }
  if (view.credentialStore === 'os') {
    return <span className="badge badge-warn">{t('accounts.store.os')}</span>
  }
  return null
}

function SessionBadge({ view }: { view: AccountView }): ReactNode {
  const t = useAppStore((state) => state.t)
  if (view.conflict) return <span className="badge badge-danger">{t('accounts.badge.conflict')}</span>
  if (!view.signedIn) return <span className="badge">{t('accounts.badge.noSession')}</span>
  return null
}

const AccountCard = memo(function AccountCard({
  view,
  onSwitch,
  onVerify,
  onRemove,
  onRemark,
  busy
}: {
  view: AccountView
  onSwitch: (id: string) => void
  onVerify: (id: string) => void
  onRemove: (id: string) => void
  onRemark: (id: string, remark: string) => void
  busy: boolean
}): ReactNode {
  const t = useAppStore((state) => state.t)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(view.remark)

  // A rename from elsewhere (or a switch) must not leave a stale draft behind.
  useEffect(() => {
    setDraft(view.remark)
    setEditing(false)
  }, [view.remark, view.id])

  return (
    <div
      className="flex flex-col gap-2 rounded-[var(--radius-sm)] border p-3"
      style={{
        borderColor: view.active ? 'var(--accent)' : 'var(--border)',
        background: view.active ? 'var(--accent-soft)' : 'var(--panel-2)'
      }}
    >
      <div className="flex items-start gap-2">
        <Icon name="user" size={14} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13px] font-semibold">{view.name || t('accounts.unnamed')}</span>
            {view.active ? <span className="badge badge-accent">{t('accounts.badge.active')}</span> : null}
            <SessionBadge view={view} />
            <CredentialBadge view={view} />
          </div>
          <div className="mono mt-0.5 truncate text-[11.5px] faint">
            {view.email || t('accounts.row.noSession')}
          </div>
          {view.remark ? <div className="mt-1 truncate text-[11.5px] dim">{view.remark}</div> : null}
          {view.conflict ? (
            <p className="mt-1.5 text-[11.5px] leading-relaxed" style={{ color: 'var(--danger)' }}>
              {t(`accounts.conflict.${view.conflict}`)}
            </p>
          ) : null}
        </div>
      </div>

      {editing ? (
        <div className="flex items-center gap-2">
          <input
            className="input h-[26px] flex-1"
            value={draft}
            placeholder={t('accounts.remarkPlaceholder')}
            maxLength={200}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                onRemark(view.id, draft)
                setEditing(false)
              }
              if (event.key === 'Escape') setEditing(false)
            }}
          />
          <button
            type="button"
            className="btn btn-primary h-[26px]"
            onClick={() => {
              onRemark(view.id, draft)
              setEditing(false)
            }}
          >
            {t('common.save')}
          </button>
          <button type="button" className="btn h-[26px]" onClick={() => setEditing(false)}>
            {t('common.cancel')}
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            className="btn h-[26px]"
            disabled={busy || view.active}
            onClick={() => onSwitch(view.id)}
          >
            <Icon name="check" size={12} />
            {view.active ? t('accounts.badge.active') : t('accounts.switch')}
          </button>
          <button type="button" className="btn h-[26px]" disabled={busy} onClick={() => onVerify(view.id)}>
            <Icon name="refresh" size={12} />
            {t('accounts.verify')}
          </button>
          <button type="button" className="btn h-[26px]" disabled={busy} onClick={() => setEditing(true)}>
            {t('accounts.remark')}
          </button>
          <button
            type="button"
            className="btn h-[26px]"
            disabled={busy || !view.stateDir}
            onClick={() => void window.api.reveal(view.stateDir)}
            title={view.stateDir}
          >
            <Icon name="folder" size={12} />
            {t('accounts.reveal')}
          </button>
          <button
            type="button"
            className="btn btn-danger h-[26px]"
            disabled={busy || view.active}
            onClick={() => onRemove(view.id)}
            title={view.active ? t('accounts.remove.disabled') : undefined}
          >
            <Icon name="trash" size={12} />
            {t('accounts.remove')}
          </button>
        </div>
      )}
    </div>
  )
})

export function AccountManager(): ReactNode {
  const t = useAppStore((state) => state.t)
  const accounts = useAppStore((state) => state.accounts)
  const addAccount = useAppStore((state) => state.addAccount)
  const activateAccount = useAppStore((state) => state.activateAccount)
  const verifyAccount = useAppStore((state) => state.verifyAccount)
  const updateAccount = useAppStore((state) => state.updateAccount)
  const removeAccount = useAppStore((state) => state.removeAccount)
  const getAccounts = useAppStore((state) => state.getAccounts)

  const open = useUiStore((state) => state.accountsOpen)
  const setOpen = useUiStore((state) => state.setAccountsOpen)
  const setAuthOpen = useUiStore((state) => state.setAuthOpen)
  const toast = useUiStore((state) => state.toast)
  const askConfirm = useUiStore((state) => state.askConfirm)

  const [busy, setBusy] = useState(false)

  // Opening the panel re-probes: "signed in" is a claim about Apple's servers,
  // and the cheapest honest answer is one `auth info` per account.
  useEffect(() => {
    if (!open) return
    void getAccounts().catch(() => undefined)
  }, [open, getAccounts])

  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true)
    try {
      await action()
    } finally {
      setBusy(false)
    }
  }

  const onSwitch = (id: string): void =>
    void run(async () => {
      const result = await activateAccount(id)
      if (result.ok) toast({ kind: 'success', message: t('accounts.switched') })
      else if (result.status === 'signed-out') setAuthOpen(true)
      else toast({ kind: 'warn', message: result.message || t('accounts.switchFailed') })
    })

  const onVerify = (id: string): void =>
    void run(async () => {
      const result = await verifyAccount(id)
      const kind = result.ok ? 'success' : result.status === 'signed-out' ? 'warn' : 'error'
      toast({ kind, message: result.ok ? t('accounts.verified') : result.message || t('accounts.verifyFailed') })
    })

  const onAdd = (): void =>
    void run(async () => {
      const created = await addAccount('')
      if (!created) return
      setOpen(false)
      setAuthOpen(true)
    })

  const onRemove = (id: string): void =>
    void run(async () => {
      const view = accounts.accounts.find((entry) => entry.id === id)
      const ok = await askConfirm({
        title: t('accounts.remove.title'),
        body: t('accounts.remove.body', { name: view?.name || view?.email || id }),
        confirmLabel: t('accounts.remove.confirm'),
        danger: true
      })
      if (!ok) return
      if (await removeAccount(id)) toast({ kind: 'success', message: t('accounts.remove.done') })
    })

  const storeNote =
    accounts.credentialSlot === 'os'
      ? accounts.slotBridge === 'available'
        ? t('accounts.slot.sharedManaged')
        : t('accounts.slot.sharedUnmanaged')
      : t('accounts.slot.perAccount')

  return (
    <Modal
      open={open}
      title={t('accounts.title')}
      subtitle={t('accounts.subtitle')}
      onClose={() => setOpen(false)}
      width={560}
      footer={
        <>
          <button type="button" className="btn" onClick={() => void getAccounts()}>
            <Icon name="refresh" size={13} />
            {t('accounts.refreshAll')}
          </button>
          <button type="button" className="btn btn-primary" onClick={onAdd} disabled={busy}>
            {busy ? <Spinner size={13} /> : <Icon name="plus" size={13} />}
            {t('accounts.add')}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-[11.5px] leading-relaxed faint">{storeNote}</p>

        {accounts.legacy ? (
          <p className="text-[11.5px] leading-relaxed" style={{ color: 'var(--warn)' }}>
            {accounts.legacy.quarantined
              ? t('accounts.legacy.quarantined', { path: accounts.legacy.quarantined })
              : t('accounts.legacy.adopted')}
          </p>
        ) : null}

        {accounts.accounts.map((view) => (
          <AccountCard
            key={view.id}
            view={view}
            busy={busy}
            onSwitch={onSwitch}
            onVerify={onVerify}
            onRemove={onRemove}
            onRemark={(id, remark) => void run(() => updateAccount(id, remark))}
          />
        ))}
      </div>
    </Modal>
  )
}
