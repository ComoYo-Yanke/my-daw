import { useEffect, useState } from 'react'
import { getAudioContext } from '../audio/engine'
import { useDawStore } from '../state/useDawStore'
import type { Playback } from '../state/useDawStore'

/**
 * Which step of its loop a channel is sounding right now, or null when the step
 * loop is not running.
 *
 * The position is not worked out here. The tempo, the swing and the step count
 * can all be changed while the loop runs, so any arithmetic from a start time
 * would drift away from what is actually being heard; the scheduler keeps the
 * steps it has already handed to the audio clock, and this asks it which of them
 * the clock is inside. Every returned value is per channel because each channel
 * loops over its own step count.
 *
 * Same rule as the playhead: requestAnimationFrame decides only *when to
 * repaint*, and the time passed to the scheduler always comes from
 * `AudioContext.currentTime`.
 */
export function useStepCursor(playback: Playback | null, channelId: string): number | null {
  const [step, setStep] = useState<number | null>(null)
  const looping = playback?.mode === 'steps'

  useEffect(() => {
    if (!looping) return

    let frame = 0
    const tick = (): void => {
      setStep(useDawStore.getState().soundingStepAt(channelId, getAudioContext().currentTime))
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(frame)
      setStep(null)
    }
  }, [looping, channelId])

  return looping ? step : null
}
