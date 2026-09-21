import { useState } from 'react'
import { useDawStore } from '../state/useDawStore'
import { MAX_BPM, MIN_BPM } from '../types/note'

/**
 * The project tempo, as a number the user types.
 *
 * The field holds its own text while it is being edited and only writes back on
 * blur or Enter. Committing on every keystroke would clamp as the user types —
 * clearing the field to retype "140" would pass through "1" and be dragged up to
 * the minimum before the rest of the number arrived.
 */
function BpmField(): React.JSX.Element {
  const bpm = useDawStore((state) => state.bpm)
  const setBpm = useDawStore((state) => state.setBpm)
  /** Non-null only while the field is being edited. */
  const [draft, setDraft] = useState<string | null>(null)

  const commit = (): void => {
    if (draft === null) return
    const parsed = Number(draft)
    if (Number.isFinite(parsed)) setBpm(parsed)
    setDraft(null)
  }

  return (
    <label className="bpm" title={`速度 ${MIN_BPM}–${MAX_BPM} BPM`}>
      <span className="bpm__label">BPM</span>
      <input
        className="bpm__input"
        type="number"
        min={MIN_BPM}
        max={MAX_BPM}
        step={1}
        value={draft ?? String(bpm)}
        onChange={(event) => setDraft(event.target.value)}
        onFocus={(event) => event.currentTarget.select()}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            commit()
            event.currentTarget.blur()
          } else if (event.key === 'Escape') {
            setDraft(null)
          }
        }}
      />
    </label>
  )
}

export default BpmField
