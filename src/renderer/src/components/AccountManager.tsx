import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { ProfileView } from '@shared/ipc'
import { useAppStore } from '@renderer/store/app'
import { useProfilesStore, activeProfile } from '@renderer/store/profiles'
import { useUiStore } from '@renderer/store/ui'
import { AppIcon } from './AppIcon'
import { Icon, Spinner } from './Icon'
import { Modal } from './Modal'

/**
 * Account switcher.
 *
 * Each entry is an ipatool profile backed by its own state directory, so
 * switching never logs another account out and downloads keep belonging to the
 * account that started them.
 */
export function AccountManager(): ReactNode {
  const t = useAppStore((state) => state.t)
  const open = useUiStore((state) => state.accountsOpen)
  const setOpen = useUiStore((state) => state.setAccountsOpen)
  const setAuthOpen = useUiStore((state) => state.setAuthOpen)
  const askConfirm = useUiStore((state) => state.askConfirm)

  const profiles = useProfilesStore((state) => state.profiles)
  const loaded = useProfilesStore((state) => state.loaded)
  const busy = useProfilesStore((state) => state.busy)
  const load = useProfilesStore((state) => state.load)
  const add = useProfilesStore((state) => state.add)
  const rename = useProfilesStore((state) => state.rename)
  const remove = useProfilesStore((state) => state.remove)
  const setActive = useProfilesStore((state) => state.setActive)
  const refreshInfo = useProfilesStore((state) => state.refreshInfo)
  const setStateDir = useProfilesStore((state) => state.setStateDir)

  const [newName, setNewName] = useState('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [editingDirId, setEditingDirId] = useState<string | null>(null)
  const [dirValue, setDirValue] = useState('')

  useEffect(() => {
    if (open && !loaded) void load()
  }, [open, loaded, load])

  const current = activeProfile(profiles)

  const startRename = (profile: ProfileView): void => {
    setRenamingId(profile.id)
    setRenameValue(profile.name)
  }

  const commitRename = async (): Promise<void> => {
    if (renamingId) await rename(renamingId, renameValue)
    setRenamingId(null)
  }

  const startDirEdit = (profile: ProfileView): void => {
    setEditingDirId(profile.id)
    setDirValue(profile.stateDir)
  }

  const commitDir = async (): Promise<void> => {
    if (editingDirId) await setStateDir(editingDirId, dirValue)
    setEditingDirId(null)
  }

  const doRemove = async (profile: ProfileView): Promise<void> => {
    const confirmed = await askConfirm({
      title: `${t('accounts.remove')}: ${profile.name}`,
      body: profile.email
        ? t('accounts.removeConfirmBody', { email: profile.email })
        : t('accounts.removeConfirmBodyAnonymous'),
      confirmLabel: t('accounts.remove'),
      danger: true
    })
    if (!confirmed) return
    await remove(profile.id)
  }

  return (
    <Modal
      open={open}
      title={t('accounts.title')}
      subtitle={t('accounts.subtitle')}
      onClose={() => setOpen(false)}
      width={560}
      footer={
        <>
          <div className="mr-auto flex min-w-0 items-center gap-2">
            <input
              className="input h-[30px] w-[180px]"
              value={newName}
              placeholder={t('accounts.addPlaceholder')}
              spellCheck={false}
              onChange={(event) => setNewName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void add(newName).then(() => setNewName(''))
                }
              }}
            />
            <button
              type="button"
              className="btn btn-primary h-[30px]"
              disabled={busy !== null}
              onClick={() => void add(newName).then(() => setNewName(''))}
            >
              {busy === 'add' ? <Spinner size={13} /> : <Icon name="plus" size={13} />}
              {t('accounts.add')}
            </button>
          </div>
          <button type="button" className="btn" onClick={() => setOpen(false)}>
            {t('common.close')}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        {!loaded ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 2 }, (_, index) => (
              <div key={index} className="skeleton h-[64px] w-full" />
            ))}
          </div>
        ) : null}

        {loaded && profiles.length === 0 ? (
          <p className="py-6 text-center text-[12.5px] faint">{t('accounts.empty')}</p>
        ) : null}

        {profiles.map((profile) => (
          <div
            key={profile.id}
            className="card flex items-start gap-3 px-3 py-2.5"
            style={profile.active ? { borderColor: 'var(--accent)' } : undefined}
          >
            <AppIcon appId={0} name={profile.email || profile.name} size={34} radius={17} />

            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                {renamingId === profile.id ? (
                  <input
                    className="input h-[24px] flex-1 text-[12.5px]"
                    value={renameValue}
                    autoFocus
                    onChange={(event) => setRenameValue(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void commitRename()
                      if (event.key === 'Escape') setRenamingId(null)
                    }}
                    onBlur={() => void commitRename()}
                  />
                ) : (
                  <span className="truncate text-[13px] font-medium">{profile.name}</span>
                )}
                {profile.active ? (
                  <span className="badge badge-accent shrink-0">{t('accounts.active')}</span>
                ) : null}
              </div>

              <p className="mono mt-0.5 truncate text-[11.5px] dim">
                {profile.email || t('accounts.notSignedIn')}
              </p>

              {editingDirId === profile.id ? (
                <div className="mt-1.5 flex items-center gap-1.5">
                  <input
                    className="input input-mono h-[24px] flex-1"
                    value={dirValue}
                    autoFocus
                    placeholder={t('accounts.stateDirPlaceholder')}
                    onChange={(event) => setDirValue(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void commitDir()
                      if (event.key === 'Escape') setEditingDirId(null)
                    }}
                  />
                  <button type="button" className="btn h-[24px]" onClick={() => void commitDir()}>
                    {t('common.save')}
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="mono mt-1 block max-w-full truncate text-left text-[10.5px] faint hover:underline"
                  title={t('accounts.stateDirHelp')}
                  onClick={() => startDirEdit(profile)}
                >
                  {profile.dir}
                </button>
              )}
            </div>

            <div className="flex shrink-0 items-center gap-0.5">
              {!profile.active ? (
                <button
                  type="button"
                  className="btn h-[26px]"
                  disabled={busy !== null}
                  onClick={() => void setActive(profile.id)}
                  title={t('accounts.switch')}
                >
                  {busy === profile.id ? <Spinner size={12} /> : <Icon name="refresh" size={12} />}
                  {t('accounts.switch')}
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-ghost btn-icon h-[26px] w-[26px]"
                  disabled={busy !== null}
                  onClick={() => void refreshInfo(profile.id)}
                  title={t('accounts.refresh')}
                >
                  {busy === profile.id ? <Spinner size={12} /> : <Icon name="refresh" size={13} />}
                </button>
              )}

              <button
                type="button"
                className="btn btn-ghost btn-icon h-[26px] w-[26px]"
                onClick={() => startRename(profile)}
                title={t('accounts.rename')}
              >
                <Icon name="settings" size={13} />
              </button>

              <button
                type="button"
                className="btn btn-ghost btn-icon h-[26px] w-[26px]"
                disabled={busy !== null || profiles.length <= 1}
                onClick={() => void doRemove(profile)}
                title={t('accounts.remove')}
                style={{ color: 'var(--danger)' }}
              >
                <Icon name="trash" size={13} />
              </button>
            </div>
          </div>
        ))}

        {current ? (
          <div className="mt-1 flex items-center justify-between gap-2">
            <p className="text-[11.5px] faint">{t('accounts.hint', { name: current.name })}</p>
            <button
              type="button"
              className="btn h-[26px] shrink-0"
              onClick={() => {
                setOpen(false)
                setAuthOpen(true)
              }}
            >
              <Icon name="user" size={12} />
              {current.email ? t('accounts.relogin') : t('accounts.signInTo')}
            </button>
          </div>
        ) : null}
      </div>
    </Modal>
  )
}
