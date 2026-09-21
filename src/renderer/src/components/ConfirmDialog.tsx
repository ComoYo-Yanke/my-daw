import { useEffect } from 'react'

type ConfirmDialogProps = {
  /** What is about to happen, and what it costs. */
  text: string
  /** The word on the button that goes through with it. */
  confirmLabel: string
  onConfirm: () => void
  onCancel: () => void
}

/**
 * A yes/no question, asked inside the window.
 *
 * In the window rather than out of it, unlike the unsaved-changes prompt: that
 * one has to survive the same click that opened it, whereas this one is opened
 * by a menu that has already closed, so an in-app dialog cannot be dismissed by
 * the press that got here. It also means the renderer needs no new IPC — the
 * only dialog the main process offers is `confirmDiscard`.
 *
 * Cancel is focused, not the destructive button: a dialog that appears under the
 * pointer should not be answerable with Return by accident.
 */
function ConfirmDialog({
  text,
  confirmLabel,
  onConfirm,
  onCancel
}: ConfirmDialogProps): React.JSX.Element {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onCancel])

  return (
    <div
      className="confirm"
      role="dialog"
      aria-modal="true"
      onPointerDown={(event) => {
        // The scrim is a way out; the box on top of it is not.
        if (event.target === event.currentTarget) onCancel()
      }}
    >
      <div className="confirm__box">
        <p className="confirm__text">{text}</p>
        <div className="confirm__actions">
          <button type="button" className="confirm__button" onClick={onCancel} autoFocus>
            取消
          </button>
          <button
            type="button"
            className="confirm__button confirm__button--danger"
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

export default ConfirmDialog
