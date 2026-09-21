import { useEffect, useRef, useState } from 'react'
import { HIGHEST_PITCH, LOWEST_PITCH, isBlackKey, noteName, pitchForRow } from '../types/note'

type PianoKeysProps = {
  /** Height of one key, in pixels. The grid's lanes use this same number. */
  keyHeightPx: number
  onPreview: (pitch: number) => void
}

/**
 * The piano roll's keyboard: one key per semitone the grid can hold, highest at
 * the top.
 *
 * Five octaves, two of them below the sample's own pitch (offset 0) and three
 * above — so the range it offers is exactly the range a note can hold, and a note
 * can never be drawn somewhere the keyboard cannot point at.
 *
 * The keys are drawn as a semitone ruler rather than as a real keyboard: every
 * key is a full-width row, which is what makes each one line up with its lane in
 * the grid beside it. Only the colouring is the keyboard's, and the name is the
 * offset's — the sample's own pitch is called C4 because that is the only
 * reference a sampler that does not know its root note can offer.
 *
 * Key height is a prop rather than a constant because the keyboard zooms with the
 * grid: a row here and a lane there have to stay the same height, or a note would
 * sit between two keys.
 */
function PianoKeys({ keyHeightPx, onPreview }: PianoKeysProps): React.JSX.Element {
  const keys = Array.from({ length: HIGHEST_PITCH - LOWEST_PITCH + 1 }, (_, row) =>
    pitchForRow(row)
  )

  /** The key under the pointer while it is down, or null. */
  const [pressedPitch, setPressedPitch] = useState<number | null>(null)
  /**
   * Whether a press is still happening.
   *
   * A ref rather than state because it is read inside pointer handlers for keys
   * that have not been entered yet, and it must be current by then: the pointer
   * arrives at the next key before React has re-rendered the last one.
   */
  const pressingRef = useRef(false)

  // The release can land on any key, or off the keyboard entirely, so it is the
  // window that ends the press rather than whichever key happens to be under it.
  useEffect(() => {
    const release = (): void => {
      pressingRef.current = false
      setPressedPitch(null)
    }
    window.addEventListener('pointerup', release)
    window.addEventListener('pointercancel', release)
    return () => {
      window.removeEventListener('pointerup', release)
      window.removeEventListener('pointercancel', release)
    }
  }, [])

  const press = (pitch: number): void => {
    pressingRef.current = true
    setPressedPitch(pitch)
    onPreview(pitch)
  }

  return (
    <div className="pr-keys" role="group" aria-label="钢琴键盘">
      {keys.map((pitch) => (
        <div
          key={pitch}
          className="pr-key"
          data-black={isBlackKey(pitch)}
          // Marks the sample's own pitch, so the row a part was written in stays
          // findable however far the grid is scrolled.
          data-root={pitch === 0}
          data-pressed={pressedPitch === pitch}
          style={{ height: `${keyHeightPx}px` }}
          onPointerDown={(event) => {
            if (event.button !== 0) return
            // Keeps the press from being read as a text selection or a drag.
            event.preventDefault()
            press(pitch)
          }}
          // Held down and moved along the keyboard, this auditions the run of keys
          // under the pointer — the same gesture a real keyboard offers.
          onPointerEnter={() => {
            if (pressingRef.current) press(pitch)
          }}
          title={`${noteName(pitch)} · 偏移 ${pitch >= 0 ? '+' : ''}${pitch} · 按住试听`}
        >
          <span className="pr-key__name">{noteName(pitch)}</span>
        </div>
      ))}
    </div>
  )
}

export default PianoKeys
