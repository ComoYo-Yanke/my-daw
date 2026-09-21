import { useEffect, useState } from 'react'
import { getAudioContext } from '../audio/engine'
import { useDawStore } from '../state/useDawStore'
import type { Playback } from '../state/useDawStore'

/**
 * How far into the pattern the piano roll's transport has got, in seconds.
 *
 * Unlike a plain sequence's playhead this one wraps: the position is not
 * `currentTime - startedAtSec`, it is where the reservation says the clock is,
 * which drops back to zero every time the transport loops. That is also why the
 * scheduler is asked rather than a start time being subtracted — the tempo and
 * the pattern's length can both change while it runs.
 *
 * Returns 0 while stopped, and null when this playback is not the piano roll's,
 * so a caller can tell "not mine" from "at the top".
 *
 * Same rule as every other cursor here: requestAnimationFrame decides only *when
 * to repaint*, and the time passed on always comes from `AudioContext.currentTime`.
 */
export function usePianoRollHead(playback: Playback | null): number | null {
  const [positionSec, setPositionSec] = useState(0)
  const isPianoRoll = playback?.mode === 'piano-roll'

  useEffect(() => {
    if (!isPianoRoll) return

    let frame = 0
    const tick = (): void => {
      const atSec = getAudioContext().currentTime
      setPositionSec(useDawStore.getState().pianoRollPositionAt(atSec) ?? 0)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(frame)
      setPositionSec(0)
    }
  }, [isPianoRoll])

  return isPianoRoll ? positionSec : null
}
