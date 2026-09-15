import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { LoginResult, LoginStatus } from '@shared/types'
import { useAppStore } from '@renderer/store/app'
import { useUiStore } from '@renderer/store/ui'
import { ErrorNotice } from '@renderer/components/ErrorNotice'
import { Icon, Spinner } from '@renderer/components/Icon'
import { Modal } from '@renderer/components/Modal'

type Step = 'credentials' | 'code'

/** Maps an ipatool login outcome onto a translated error code. */
function codeForStatus(status: LoginStatus): string | null {
  switch (status) {
    case 'needs-2fa':
      return 'two-factor-required'
    case 'passphrase-required':
      return 'passphrase-required'
    case 'bad-credentials':
      return 'bad-credentials'
    case 'rate-limited':
      return 'rate-limited'
    default:
      return null
  }
}

export function AuthModal(): ReactNode {
  const t = useAppStore((state) => state.t)
  const account = useAppStore((state) => state.account)
  const settings = useAppStore((state) => state.settings)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const refreshAccount = useAppStore((state) => state.refreshAccount)
  const revokeAccount = useAppStore((state) => state.revokeAccount)

  const open = useUiStore((state) => state.authOpen)
  const setOpen = useUiStore((state) => state.setAuthOpen)
  const toast = useUiStore((state) => state.toast)
  const setView = useUiStore((state) => state.setView)

  const [email, setEmail] = useState(settings.lastEmail)
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [remember, setRemember] = useState(Boolean(settings.lastEmail))
  const [step, setStep] = useState<Step>('credentials')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<{ message: string; code: string | null } | null>(null)
  const [checking, setChecking] = useState(false)

  // Reset transient state each time the dialog opens - and scrub the password
  // the moment it closes. The dialog stays mounted while hidden (Modal returns
  // null but this component lives on), so without the close branch the typed
  // password would linger in React state until the next open.
  useEffect(() => {
    if (!open) {
      setPassword('')
      setCode('')
      return
    }
    setStep('credentials')
    setPassword('')
    setCode('')
    setFailure(null)
    setBusy(false)
    setEmail(useAppStore.getState().settings.lastEmail)
  }, [open])

  const submit = async (): Promise<void> => {
    if (busy) return
    if (email.trim() === '' || password === '') return

    setBusy(true)
    setFailure(null)

    let result: LoginResult
    try {
      result = await window.api.login(email.trim(), password, step === 'code' ? code.trim() : undefined)
    } catch (error) {
      // The bridge itself failed (main crashed, invoke rejected): roll the UI
      // back instead of leaving the dialog spinning forever, and scrub the
      // password - the attempt is over either way.
      setFailure({ message: String(error), code: null })
      setPassword('')
      setCode('')
      setStep('credentials')
      return
    } finally {
      setBusy(false)
    }

    if (result.status === 'ok') {
      if (remember) await updateSettings({ lastEmail: email.trim() })
      else if (settings.lastEmail) await updateSettings({ lastEmail: '' })
      useAppStore.getState().setAccount(result.account)
      setOpen(false)
      toast({ kind: 'success', message: t('auth.success', { email: result.account?.email ?? email }) })
      setPassword('')
      setCode('')
      return
    }

    if (result.status === 'needs-2fa' && step === 'credentials') {
      setStep('code')
      return
    }

    setFailure({ message: result.message, code: codeForStatus(result.status) })
    if (result.status === 'needs-2fa') {
      // Wrong/expired code: the flow continues at the code step, so keep the
      // verified password and only reset the code field.
      setCode('')
    } else {
      // Any other failure ends the attempt: scrub the password and return to
      // the credentials step rather than leaving it in React state.
      setPassword('')
      setCode('')
      setStep('credentials')
    }
  }

  const recheck = async (): Promise<void> => {
    setChecking(true)
    try {
      const info = await refreshAccount()
      toast(
        info
          ? { kind: 'success', message: t('auth.success', { email: info.email }) }
          : { kind: 'warn', message: t('auth.signedOut') }
      )
    } catch (error) {
      toast({ kind: 'error', message: String(error) })
    } finally {
      setChecking(false)
    }
  }

  return (
    <Modal
      open={open}
      title={step === 'code' ? t('auth.2fa.title') : account ? t('auth.account.title') : t('auth.title')}
      subtitle={step === 'code' ? t('auth.2fa.body') : account ? undefined : t('auth.subtitle')}
      onClose={() => setOpen(false)}
      width={440}
      footer={
        step === 'code' ? (
          <>
            <button type="button" className="btn" onClick={() => setStep('credentials')} disabled={busy}>
              {t('auth.2fa.resend')}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void submit()}
              disabled={busy || code.trim().length < 4}
            >
              {busy ? <Spinner size={13} /> : null}
              {t('auth.2fa.submit')}
            </button>
          </>
        ) : account ? (
          <>
            <button type="button" className="btn" onClick={() => void recheck()} disabled={checking}>
              {checking ? <Spinner size={13} /> : <Icon name="refresh" size={13} />}
              {t('auth.account.refresh')}
            </button>
            <button type="button" className="btn btn-danger" onClick={() => void revokeAccount()}>
              {t('auth.signOut')}
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn" onClick={() => setOpen(false)}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void submit()}
              disabled={busy || email.trim() === '' || password === ''}
            >
              {busy ? <Spinner size={13} /> : null}
              {busy ? t('auth.signingIn') : t('auth.submit')}
            </button>
          </>
        )
      }
    >
      {account && step === 'credentials' ? (
        <dl className="flex flex-col gap-2.5 text-[12.5px]">
          <div className="flex items-center justify-between gap-3">
            <dt className="dim">{t('auth.account.name')}</dt>
            <dd className="truncate font-medium">{account.name || '—'}</dd>
          </div>
          <div className="flex items-center justify-between gap-3">
            <dt className="dim">{t('auth.account.email')}</dt>
            <dd className="mono truncate">{account.email}</dd>
          </div>
          <div className="divider my-1" />
          <p className="text-[11.5px] leading-relaxed faint">{t('auth.revoke.body')}</p>
        </dl>
      ) : null}

      {!account || step === 'code' ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          {step === 'credentials' ? (
            <>
              <label className="flex flex-col gap-1.5">
                <span className="text-[11.5px] font-medium dim">{t('auth.email')}</span>
                <input
                  className="input"
                  type="email"
                  value={email}
                  autoComplete="username"
                  placeholder={t('auth.emailPlaceholder')}
                  onChange={(event) => setEmail(event.target.value)}
                  disabled={busy}
                />
              </label>

              <label className="flex flex-col gap-1.5">
                <span className="text-[11.5px] font-medium dim">{t('auth.password')}</span>
                <input
                  className="input"
                  type="password"
                  value={password}
                  autoComplete="current-password"
                  placeholder={t('auth.passwordPlaceholder')}
                  onChange={(event) => setPassword(event.target.value)}
                  disabled={busy}
                />
              </label>

              <label className="flex cursor-pointer items-center gap-2 text-[11.5px] dim">
                <input
                  type="checkbox"
                  style={{ accentColor: 'var(--accent)' }}
                  checked={remember}
                  onChange={(event) => setRemember(event.target.checked)}
                />
                {t('auth.remember')}
              </label>



              <p className="text-[11.5px] leading-relaxed faint">{t('auth.slow')}</p>
            </>
          ) : (
            <label className="flex flex-col gap-1.5">
              <span className="text-[11.5px] font-medium dim">{t('auth.2fa.placeholder')}</span>
              <input
                className="input input-mono text-center text-[16px] tracking-[0.4em]"
                value={code}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={8}
                placeholder="······"
                onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
                disabled={busy}
              />
            </label>
          )}

          {failure ? (
            <ErrorNotice
              message={failure.message}
              hint={failure.code}
              onRetry={failure.code === 'rate-limited' || failure.code === null ? () => void submit() : undefined}
              onViewLog={undefined}
            />
          ) : null}

          {failure?.code === 'passphrase-required' ? (
            <button
              type="button"
              className="btn h-[26px] self-start"
              onClick={() => {
                setOpen(false)
                setView('settings')
              }}
            >
              <Icon name="settings" size={13} />
              {t('settings.section.account')}
            </button>
          ) : null}
        </form>
      ) : null}
    </Modal>
  )
}
