import type { ReactNode } from 'react'
import { useUiStore } from '@renderer/store/ui'
import { useAppStore } from '@renderer/store/app'
import { Modal } from './Modal'

/** Renders the promise-based confirm dialog owned by the UI store. */
export function ConfirmDialog(): ReactNode {
  const confirm = useUiStore((state) => state.confirm)
  const resolve = useUiStore((state) => state.resolveConfirm)
  const t = useAppStore((state) => state.t)

  return (
    <Modal
      open={confirm !== null}
      title={confirm?.title ?? ''}
      onClose={() => resolve(false)}
      width={420}
      footer={
        <>
          <button type="button" className="btn" onClick={() => resolve(false)}>
            {confirm?.cancelLabel ?? t('common.cancel')}
          </button>
          <button
            type="button"
            className={`btn ${confirm?.danger ? 'btn-danger' : 'btn-primary'}`}
            onClick={() => resolve(true)}
          >
            {confirm?.confirmLabel ?? t('common.ok')}
          </button>
        </>
      }
    >
      {confirm?.body ? <p className="text-[12.5px] leading-relaxed dim">{confirm.body}</p> : null}
    </Modal>
  )
}
