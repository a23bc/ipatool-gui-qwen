import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { EngineRelease, LocaleMode, PassphraseMode, Platform, ThemeMode } from '@shared/types'
import type { Key } from '@renderer/i18n'
import { useAppStore, engineReady } from '@renderer/store/app'
import { useUiStore } from '@renderer/store/ui'
import { Icon, Spinner } from '@renderer/components/Icon'
import { PlatformSelect } from '@renderer/components/Badges'
import { Choice, Field, NumberInput, Section, TextInput, Toggle } from '@renderer/components/SettingsControls'

const SOURCE_KEY: Record<string, Key> = {
  settings: 'settings.engine.source.settings',
  env: 'settings.engine.source.env',
  path: 'settings.engine.source.path',
  managed: 'settings.engine.source.managed'
}

export function SettingsView(): ReactNode {
  const t = useAppStore((state) => state.t)
  const settings = useAppStore((state) => state.settings)
  const update = useAppStore((state) => state.updateSettings)
  const reset = useAppStore((state) => state.resetSettings)
  const engine = useAppStore((state) => state.engine)
  const detect = useAppStore((state) => state.detectEngine)
  const install = useAppStore((state) => state.installEngine)
  const uninstall = useAppStore((state) => state.uninstallEngine)
  const appInfo = useAppStore((state) => state.appInfo)
  const account = useAppStore((state) => state.account)
  const revokeAccount = useAppStore((state) => state.revokeAccount)
  const toast = useUiStore((state) => state.toast)
  const askConfirm = useUiStore((state) => state.askConfirm)
  const setAuthOpen = useUiStore((state) => state.setAuthOpen)

  const [releases, setReleases] = useState<EngineRelease[]>([])
  const [releasesLoading, setReleasesLoading] = useState(false)
  const [detecting, setDetecting] = useState(false)
  const [updateState, setUpdateState] = useState<'idle' | 'checking' | 'done'>('idle')
  const [updateInfo, setUpdateInfo] = useState<{ latest: string | null; hasUpdate: boolean; url: string | null } | null>(null)

  useEffect(() => {
    let alive = true
    setReleasesLoading(true)
    window.api
      .listEngineReleases()
      .then((result) => {
        if (alive && result.ok) setReleases(result.data.filter((release) => release.hasAssetForThisPlatform))
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setReleasesLoading(false)
      })
    return () => {
      alive = false
    }
  }, [])

  const redetect = async (): Promise<void> => {
    setDetecting(true)
    const status = await detect(true)
    setDetecting(false)
    toast(
      engineReady(status)
        ? { kind: 'success', message: `${status.path}` }
        : { kind: 'warn', message: status.message ?? t('engine.pill.missing') }
    )
  }

  const checkUpdate = async (): Promise<void> => {
    setUpdateState('checking')
    const result = await window.api.checkAppUpdate()
    setUpdateState('done')
    if (result.error === 'update-check-not-configured') {
      setUpdateInfo(null)
      toast({ kind: 'info', message: t('settings.about.updateNone') })
      return
    }
    if (result.error) {
      setUpdateInfo(null)
      toast({ kind: 'error', message: t('settings.about.updateFailed'), detail: result.error })
      return
    }
    setUpdateInfo({ latest: result.latest, hasUpdate: result.hasUpdate, url: result.url })
    toast({
      kind: result.hasUpdate ? 'success' : 'info',
      message: result.hasUpdate
        ? t('settings.about.updateAvailable', { version: result.latest ?? '' })
        : t('settings.about.updateLatest'),
      ...(result.hasUpdate && result.url
        ? { actionLabel: t('common.open'), onAction: () => void window.api.openExternal(result.url as string) }
        : {})
    })
  }

  const clearArtwork = async (): Promise<void> => {
    const removed = await window.api.clearArtworkCache()
    toast({ kind: 'success', message: t('settings.downloads.artworkCleared', { n: removed }) })
  }

  const doReset = async (): Promise<void> => {
    const confirmed = await askConfirm({
      title: t('settings.advanced.reset'),
      body: t('settings.advanced.resetConfirm'),
      confirmLabel: t('settings.advanced.reset'),
      danger: true
    })
    if (!confirmed) return
    await reset()
    toast({ kind: 'success', message: t('toast.settingsReset') })
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="mx-auto flex max-w-[760px] flex-col gap-4 px-5 py-5">
        {/* ---------------- engine ---------------- */}
        <Section title={t('settings.section.engine')}>
          <Field label={t('settings.engine.status')}>
            <div className="flex items-center gap-2">
              <span
                className="h-2 w-2 rounded-full"
                style={{
                  background: engineReady(engine)
                    ? 'var(--success)'
                    : engine.state === 'downloading'
                      ? 'var(--warn)'
                      : 'var(--danger)'
                }}
              />
              <span className="mono text-[11.5px] dim">
                {engineReady(engine)
                  ? t('settings.engine.detected', {
                      path: engine.path ?? '',
                      source: engine.source ? t(SOURCE_KEY[engine.source]) : ''
                    })
                  : t('settings.engine.notDetected')}
              </span>
              {engine.version ? <span className="badge badge-accent">{engine.version}</span> : null}
            </div>
          </Field>

          <Field label={t('settings.engine.path')} hint={t('settings.engine.pathHelp')} stacked>
            <div className="flex items-center gap-2">
              <TextInput
                value={settings.ipatoolPath}
                onChange={(value) => void update({ ipatoolPath: value })}
                placeholder="/opt/homebrew/bin/ipatool"
                mono
                className="flex-1"
              />
              <button type="button" className="btn h-[30px]" onClick={() => void redetect()} disabled={detecting}>
                {detecting ? <Spinner size={13} /> : <Icon name="refresh" size={13} />}
                {t('settings.engine.redetect')}
              </button>
            </div>
          </Field>

          <Toggle
            checked={settings.autoInstallEngine}
            onChange={(value) => void update({ autoInstallEngine: value })}
            label={t('settings.engine.autoInstall')}
            hint={t('settings.engine.autoInstallHelp')}
          />

          <Field label={t('settings.engine.version')} hint={releasesLoading ? t('settings.engine.releasesLoading') : undefined}>
            <select
              className="select w-[190px]"
              value={settings.engineVersion}
              onChange={(event) => void update({ engineVersion: event.target.value })}
            >
              <option value="">{t('settings.engine.versionLatest')}</option>
              {releases.map((release) => (
                <option key={release.version} value={release.version}>
                  {release.version}
                  {release.prerelease ? ' (pre)' : ''}
                </option>
              ))}
            </select>
          </Field>

          <Field label={t('settings.engine.mirror')} hint={t('settings.engine.mirrorHelp')} stacked>
            <TextInput
              value={settings.githubMirror}
              onChange={(value) => void update({ githubMirror: value })}
              placeholder={t('settings.engine.mirrorPlaceholder')}
              mono
              className="w-full"
            />
          </Field>

          <Field label={t('settings.engine.uninstall')} hint={t('settings.engine.uninstallHelp')}>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="btn h-[28px]"
                disabled={engine.state === 'downloading'}
                title={t('settings.engine.installHelp')}
                onClick={() => {
                  void install(settings.engineVersion).then((status) => {
                    toast(
                      engineReady(status)
                        ? { kind: 'success', message: t('toast.engineInstalled', { version: status.version ?? '' }) }
                        : { kind: 'error', message: t('toast.engineFailed'), detail: status.message ?? undefined }
                    )
                  })
                }}
              >
                {engine.state === 'downloading' ? <Spinner size={13} /> : <Icon name="download" size={13} />}
                {t('engine.setup.install')}
              </button>
              {engine.source === 'managed' ? (
                <button type="button" className="btn btn-danger h-[28px]" onClick={() => void uninstall()}>
                  <Icon name="trash" size={13} />
                  {t('settings.engine.uninstall')}
                </button>
              ) : null}
            </div>
          </Field>

          {appInfo ? (
            <Field label={t('settings.engine.info')} stacked>
              <dl className="mono grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px] dim">
                <dt className="faint">userData</dt>
                <dd className="truncate">{appInfo.paths.userData}</dd>
                <dt className="faint">downloads</dt>
                <dd className="truncate">{appInfo.paths.downloads}</dd>
                <dt className="faint">platform</dt>
                <dd>
                  {appInfo.platform}/{appInfo.arch}
                </dd>
              </dl>
            </Field>
          ) : null}
        </Section>

        {/* ---------------- account ---------------- */}
        <Section title={t('settings.section.account')}>
          <Field label={t('auth.account.title')}>
            <div className="flex items-center gap-2">
              {account ? (
                <>
                  <span className="mono text-[11.5px] dim">{account.email}</span>
                  <button type="button" className="btn btn-danger h-[28px]" onClick={() => void revokeAccount()}>
                    {t('auth.signOut')}
                  </button>
                </>
              ) : (
                <button type="button" className="btn btn-primary h-[28px]" onClick={() => setAuthOpen(true)}>
                  <Icon name="user" size={13} />
                  {t('auth.signIn')}
                </button>
              )}
            </div>
          </Field>

          <Field label={t('settings.account.passphrase')} hint={t('settings.account.passphraseHelp')} stacked>
            <Choice<PassphraseMode>
              value={settings.passphraseMode}
              onChange={(value) => void update({ passphraseMode: value })}
              options={[
                { value: 'auto', label: t('settings.account.passphraseMode.auto') },
                { value: 'manual', label: t('settings.account.passphraseMode.manual') },
                { value: 'none', label: t('settings.account.passphraseMode.none') }
              ]}
            />
          </Field>

          {settings.passphraseMode === 'manual' ? (
            <Field label={t('settings.account.passphraseValue')} hint={t('settings.account.passphraseWarning')} stacked>
              <TextInput
                value={settings.keychainPassphrase === '********' ? '' : settings.keychainPassphrase}
                onChange={(value) => void update({ keychainPassphrase: value })}
                type="password"
                mono
                className="w-full"
              />
            </Field>
          ) : null}

          <Field label={t('settings.account.stateDir')} hint={t('settings.account.stateDirHelp')} stacked>
            <TextInput
              value={settings.stateDir}
              onChange={(value) => void update({ stateDir: value })}
              placeholder="~/.local/state/ipatool-gui"
              mono
              className="w-full"
            />
          </Field>

          <Toggle
            checked={settings.verbose}
            onChange={(value) => void update({ verbose: value })}
            label={t('settings.account.verbose')}
          />
        </Section>

        {/* ---------------- downloads ---------------- */}
        <Section title={t('settings.section.downloads')}>
          <Field label={t('settings.downloads.dir')} hint={t('settings.downloads.dirHelp')} stacked>
            <div className="flex items-center gap-2">
              <TextInput
                value={settings.downloadDir}
                onChange={(value) => void update({ downloadDir: value })}
                mono
                className="flex-1"
              />
              <button
                type="button"
                className="btn h-[30px]"
                onClick={() => {
                  void window.api
                    .pickDirectory(t('settings.downloads.dir'), settings.downloadDir)
                    .then((picked) => {
                      if (picked) void update({ downloadDir: picked })
                    })
                }}
              >
                <Icon name="folder" size={13} />
                {t('common.browse')}
              </button>
            </div>
          </Field>

          <Field
            label={t('settings.downloads.concurrency')}
            hint={t('settings.downloads.concurrencyHelp')}
          >
            <NumberInput
              value={settings.concurrency}
              min={1}
              max={8}
              onChange={(value) => void update({ concurrency: value })}
            />
          </Field>

          <Toggle
            checked={settings.autoPurchase}
            onChange={(value) => void update({ autoPurchase: value })}
            label={t('settings.downloads.autoPurchase')}
            hint={t('settings.downloads.autoPurchaseHelp')}
          />

          <Field label={t('settings.downloads.defaultPlatform')}>
            <PlatformSelect
              value={settings.defaultPlatform as Platform}
              onChange={(value) => void update({ defaultPlatform: value })}
              className="w-[190px]"
            />
          </Field>

          <Field label={t('settings.downloads.searchLimit')}>
            <NumberInput
              value={settings.searchLimit}
              min={1}
              max={200}
              step={5}
              onChange={(value) => void update({ searchLimit: value })}
            />
          </Field>

          <Field label={t('settings.downloads.pageSize')}>
            <NumberInput
              value={settings.purchasesPageSize}
              min={10}
              max={1000}
              step={10}
              onChange={(value) => void update({ purchasesPageSize: value })}
            />
          </Field>

          <Toggle
            checked={settings.resumeQueueOnLaunch}
            onChange={(value) => void update({ resumeQueueOnLaunch: value })}
            label={t('settings.downloads.resume')}
          />

          <Toggle
            checked={settings.notifyOnComplete}
            onChange={(value) => void update({ notifyOnComplete: value })}
            label={t('settings.downloads.notify')}
          />

          <Toggle
            checked={settings.artworkEnabled}
            onChange={(value) => void update({ artworkEnabled: value })}
            label={t('settings.downloads.artwork')}
          />

          <Field
            label={t('settings.downloads.artworkCountry')}
            hint={t('settings.downloads.artworkCountryHelp')}
          >
            <div className="flex items-center gap-2">
              <TextInput
                value={settings.artworkCountry}
                onChange={(value) => void update({ artworkCountry: value.slice(0, 2).toLowerCase() })}
                mono
                className="w-[70px] text-center uppercase"
              />
              <button type="button" className="btn btn-ghost h-[28px]" onClick={() => void clearArtwork()}>
                <Icon name="trash" size={13} />
                {t('settings.downloads.clearArtwork')}
              </button>
            </div>
          </Field>
        </Section>

        {/* ---------------- appearance ---------------- */}
        <Section title={t('settings.section.appearance')}>
          <Field label={t('settings.appearance.theme')}>
            <Choice<ThemeMode>
              value={settings.theme}
              onChange={(value) => void update({ theme: value })}
              options={[
                { value: 'system', label: t('settings.appearance.theme.system') },
                { value: 'light', label: t('settings.appearance.theme.light') },
                { value: 'dark', label: t('settings.appearance.theme.dark') }
              ]}
            />
          </Field>

          <Field label={t('settings.appearance.language')}>
            <Choice<LocaleMode>
              value={settings.locale}
              onChange={(value) => void update({ locale: value })}
              options={[
                { value: 'system', label: t('settings.appearance.language.system') },
                { value: 'zh-CN', label: '中文' },
                { value: 'en-US', label: 'English' }
              ]}
            />
          </Field>

          <Field label={t('settings.appearance.maxLogLines')}>
            <NumberInput
              value={settings.maxLogLines}
              min={100}
              max={50000}
              step={500}
              onChange={(value) => void update({ maxLogLines: value })}
            />
          </Field>
        </Section>

        {/* ---------------- advanced ---------------- */}
        <Section title={t('settings.section.advanced')}>
          <Toggle
            checked={settings.confirmCloseWhileDownloading}
            onChange={(value) => void update({ confirmCloseWhileDownloading: value })}
            label={t('settings.advanced.confirmClose')}
          />

          <Field label={t('settings.advanced.openSettingsFile')}>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="btn h-[28px]"
                onClick={() => void window.api.openPath(appInfo?.paths.userData ?? '')}
              >
                <Icon name="folder" size={13} />
                {t('settings.advanced.openUserData')}
              </button>
              <button type="button" className="btn btn-danger h-[28px]" onClick={() => void doReset()}>
                <Icon name="refresh" size={13} />
                {t('settings.advanced.reset')}
              </button>
            </div>
          </Field>
        </Section>

        {/* ---------------- about ---------------- */}
        <Section title={t('settings.section.about')}>
          <Field label={t('settings.about.version')}>
            <div className="flex items-center gap-2">
              <span className="mono text-[11.5px] dim">
                {appInfo ? `v${appInfo.appVersion}` : '—'}
              </span>
              <button
                type="button"
                className="btn h-[26px]"
                onClick={() => void checkUpdate()}
                disabled={updateState === 'checking'}
              >
                {updateState === 'checking' ? <Spinner size={12} /> : <Icon name="refresh" size={12} />}
                {t('settings.about.checkUpdate')}
              </button>
              {updateInfo?.hasUpdate ? (
                <span className="badge badge-success">{updateInfo.latest}</span>
              ) : null}
            </div>
          </Field>

          {appInfo ? (
            <Field label={t('settings.about.platform')} stacked>
              <dl className="mono grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px] dim">
                <dt className="faint">Electron</dt>
                <dd>{appInfo.electronVersion}</dd>
                <dt className="faint">Chromium</dt>
                <dd>{appInfo.chromeVersion}</dd>
                <dt className="faint">Node</dt>
                <dd>{appInfo.nodeVersion}</dd>
                <dt className="faint">{t('settings.about.platform')}</dt>
                <dd>
                  {appInfo.platform}/{appInfo.arch}
                </dd>
              </dl>
            </Field>
          ) : null}

          <Field label={t('settings.about.upstream')}>
            <button
              type="button"
              className="btn btn-ghost h-[26px]"
              onClick={() => void window.api.openExternal('https://github.com/majd/ipatool')}
            >
              <Icon name="external" size={13} />
              majd/ipatool
            </button>
          </Field>

          <div className="flex flex-col gap-2 px-4 py-3 text-[11.5px] leading-relaxed faint">
            <p>{t('settings.about.license')}</p>
            <p>{t('settings.about.disclaimer')}</p>
          </div>
        </Section>
      </div>
    </div>
  )
}
