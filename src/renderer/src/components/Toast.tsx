import { useEffect } from 'react'
import { useDawStore } from '../state/useDawStore'

/** How long a message stays up, in milliseconds. */
const TOAST_MS = 2200

/**
 * The one-off acknowledgement — "已保存" — that confirms something happened
 * without taking over the screen the way the error banner does.
 *
 * It closes itself on a timer, which is a UI timer and nothing more: every time
 * that reaches the audio nodes still comes from `AudioContext.currentTime`.
 */
function Toast(): React.JSX.Element | null {
  const toast = useDawStore((state) => state.toast)
  const clearToast = useDawStore((state) => state.clearToast)

  useEffect(() => {
    if (toast === null) return
    const timer = setTimeout(clearToast, TOAST_MS)
    return () => clearTimeout(timer)
  }, [toast, clearToast])

  if (toast === null) return null

  return (
    <div className="toast" role="status">
      {toast}
    </div>
  )
}

export default Toast
