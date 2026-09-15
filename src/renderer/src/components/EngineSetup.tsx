import { useState } from 'react'
import type { ReactNode } from 'react'
import { formatBytes } from '@shared/format'
import type { Key } from '@renderer/i18n'
import { useAppStore, engineReady } from '@renderer/store/app'
import { useUiStore } from '@renderer/store/ui'
import { Icon, Spinner } from '@renderer/components/Icon'
import { Modal } from './Modal'

const PHASE_KEY: Record<string, Key> = {
  resolve: 'engine.setup.phase.resolve',
  download: 'engine.setup.phase.download',
  verify: 'engine.setup.phase.verify',
  extract: 'engine.setup.phase.extract'
}

/**
 * First-run installer for ipatool.
 *
 * The repository ships no binary, so this is the path every fresh install takes.
 * It is explicit about what happens - download, checksum verification, unpack -
 * because silently fetching and executing a binary is exactly the kind of thing a
 * user should be able to see and decline.
 */
export function EngineSetup(): ReactNode {
  const t = useAppStore((state) => state.t)
  const engine = useAppStore((state) => state.engine)
  const installEngine = useAppStore((state) => state.installEngine)
  const detectEngine = useAppStore((state) => state.detectEngine)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const appInfo = useAppStore((state) => state.appInfo)
  const setView = useUiStore((state) => state.setView)
  const dismissSetup = useUiStore((state) => state.dismissSetup)
  const toast = useUiStore((state) => state.toast)

  const [installing, setInstalling] = useState(false)
  const [dismissed, setDismissed] = useState(false)

  const needsSetup = !engineReady(engine) && engine.state !== 'downloading' && !dismissed

  const install = async (): Promise<void> => {
    setInstalling(true)
    try {
      const status = await installEngine()
      if (status.state === 'ready') {
        dismissSetup()
        setDismissed(true)
        toast({ kind: 'success', message: t('engine.setup.done', { version: status.version ?? '' }) })
      } else {
        toast({
          kind: 'error',
          message: t('toast.engineFailed'),
          detail: status.message ?? undefined
        })
      }
    } catch (error) {
      // A rejected IPC call must not leave the install button disabled forever.
      toast({ kind: 'error', message: t('toast.engineFailed'), detail: String(error) })
    } finally {
      setInstalling(false)
    }
  }

  const chooseManual = async (): Promise<void> => {
    try {
      const picked = await window.api.pickFile('ipatool', [
        {
          name: 'ipatool',
          extensions: appInfo?.platform === 'win32' ? ['exe'] : ['*']
        }
      ])
      if (!picked) return
      await updateSettings({ ipatoolPath: picked, autoInstallEngine: false })
      const status = await detectEngine(true)
      if (engineReady(status)) {
        setDismissed(true)
        dismissSetup()
        toast({ kind: 'success', message: t('engine.setup.done', { version: status.version ?? '' }) })
      } else {
        toast({ kind: 'error', message: status.message ?? t('toast.engineFailed') })
      }
    } catch (error) {
      toast({ kind: 'error', message: t('toast.engineFailed'), detail: String(error) })
    }
  }

  const downloading = engine.state === 'downloading'
  const progress = engine.download
  const percent = progress?.percent
  const phaseKey = progress ? PHASE_KEY[progress.phase] : undefined

  return (
    <Modal
      open={needsSetup || downloading}
      title={t('engine.setup.title')}
      onClose={() => {
        if (downloading) return
        setDismissed(true)
        dismissSetup()
        setView('settings')
      }}
      width={520}
      footer={
        downloading ? null : (
          <>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setDismissed(true)
                dismissSetup()
                setView('settings')
              }}
            >
              {t('engine.setup.manual')}
            </button>
            <button type="button" className="btn btn-primary" onClick={() => void install()} disabled={installing}>
              {installing ? <Spinner size={13} /> : <Icon name="download" size={13} />}
              {t('engine.setup.install')}
            </button>
          </>
        )
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-[12.5px] leading-relaxed dim">{t('engine.setup.body')}</p>

        {engine.code ? (
          <div
            className="flex items-start gap-2.5 rounded-lg px-3 py-2.5"
            style={{ background: 'var(--danger-soft)' }}
          >
            <span className="mt-0.5 shrink-0" style={{ color: 'var(--danger)' }}>
              <Icon name="alert" size={14} />
            </span>
            <div className="min-w-0">
              <p className="text-[12.5px] font-semibold" style={{ color: 'var(--danger)' }}>
                {t(`engine.errors.${engine.code}` as Key)}
              </p>
              {engine.message ? <p className="mt-1 text-[11.5px] leading-relaxed dim">{engine.message}</p> : null}
              <p className="mt-1.5 text-[11.5px] leading-relaxed">
                {t(`engine.errors.${engine.code}.hint` as Key)}
              </p>
            </div>
          </div>
        ) : null}

        {downloading ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2 text-[12px]">
              <Spinner size={13} />
              <span>
                {phaseKey
                  ? progress?.phase === 'download' && percent != null
                    ? t(phaseKey, { percent: Math.round(percent) })
                    : t(phaseKey)
                  : t('engine.setup.installing')}
              </span>
              {progress?.total ? (
                <span className="mono ml-auto faint tabular-nums">
                  {formatBytes(progress.received)} / {formatBytes(progress.total)}
                </span>
              ) : null}
            </div>
            <div className="progress">
              <div
                className="progress-fill"
                style={{ transform: `scaleX(${(percent ?? 0) / 100})` }}
              />
            </div>
          </div>
        ) : (
          <div
            className="flex items-start gap-2.5 rounded-lg px-3 py-2.5"
            style={{ background: 'var(--panel-2)' }}
          >
            <span className="mt-0.5 shrink-0 faint">
              <Icon name="terminal" size={14} />
            </span>
            <code className="mono text-[11.5px] dim">{t('engine.setup.brew')}</code>
          </div>
        )}

        {!downloading ? (
          <button
            type="button"
            className="btn btn-ghost h-[26px] self-start"
            onClick={() => void chooseManual()}
          >
            <Icon name="folder" size={13} />
            {t('common.browse')}
          </button>
        ) : null}
      </div>
    </Modal>
  )
}
