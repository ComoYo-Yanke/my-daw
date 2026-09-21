import { useEffect, useState } from 'react'
import { getAudioContext } from '../audio/engine'
import type { Playback } from '../state/useDawStore'

/**
 * How far into the current playback we are, in seconds.
 *
 * requestAnimationFrame decides only *when to repaint*; the time itself always
 * comes from `AudioContext.currentTime`, so no cursor can drift away from what
 * is being heard. Nothing here counts seconds by itself.
 *
 * Returns 0 while stopped — derived, not stored, so there is no reset to forget.
 */
export function usePlayheadSec(playback: Playback | null): number {
  const [positionSec, setPositionSec] = useState(0)

  useEffect(() => {
    if (playback === null) return
    const { startedAtSec } = playback

    let frame = 0
    const tick = (): void => {
      setPositionSec(Math.max(0, getAudioContext().currentTime - startedAtSec))
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)

    return () => cancelAnimationFrame(frame)
  }, [playback])

  return playback === null ? 0 : positionSec
}
