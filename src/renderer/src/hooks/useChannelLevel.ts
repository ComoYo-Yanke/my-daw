import { useEffect, useRef } from 'react'

import { getStrip, readStripPeak } from '../audio/engine'

/**
 * How fast the bar gives ground, in units of full scale per second.
 *
 * Instant up and slow down, which is the shape every meter has: a bar that eased
 * its way to a peak would read low on exactly the transients it is there to show,
 * and one that snapped back down would be a flicker rather than a level.
 */
const FALL_PER_SEC = 1.6

/** How long the peak marker stays put before it starts falling. */
const PEAK_HOLD_SEC = 0.9

/** How fast the peak marker falls once its hold is up, after the bar has. */
const PEAK_FALL_PER_SEC = 0.5

/** A frame is never worth more than this, so a stalled tab does not empty the bar. */
const MAX_STEP_SEC = 0.1

/**
 * A channel's level, written onto one element as `--level` and `--peak`.
 *
 * Written rather than returned as numbers because it changes every frame: a hook
 * that set state here would re-render the whole channel row sixty times a second
 * to move a three-pixel bar, and a row holds knobs and a waveform that have no
 * reason to be rebuilt at all. Two custom properties on one span let the
 * stylesheet draw both the bar and its peak marker without React being involved
 * past the first render.
 *
 * The clock is `performance.now()` and it times nothing but this decay — the
 * level itself is read from the audio graph, so what the bar shows is what the
 * channel is actually putting out and never a guess from elapsed time. Playback
 * is still the audio clock's business alone.
 *
 * `active` is the strip's own activity — the same flag that lights the row's LED.
 * The loop runs only while it is true, so an idle rack costs nothing; when it
 * goes false the bar is cleared, since the voices that were making it have ended.
 */
export function useChannelLevel(
  channelId: string,
  active: boolean
): React.RefObject<HTMLSpanElement | null> {
  const ref = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const element = ref.current
    if (element === null) return

    if (!active) {
      element.style.setProperty('--level', '0')
      element.style.setProperty('--peak', '0')
      return
    }

    let frame = 0
    /** What the bar is showing: the peak, held by the fall rather than by a timer. */
    let shown = 0
    let peak = 0
    /** When the peak marker last moved up, which is what its hold is counted from. */
    let peakAtSec = performance.now() / 1000
    /** When the last frame ran, which is what both falls are measured over. */
    let lastSec = peakAtSec

    const tick = (): void => {
      const nowSec = performance.now() / 1000
      const stepSec = Math.min(MAX_STEP_SEC, Math.max(0, nowSec - lastSec))
      lastSec = nowSec

      const strip = getStrip(channelId)
      const raw = strip === undefined ? 0 : readStripPeak(strip)

      shown = raw >= shown ? raw : Math.max(0, shown - FALL_PER_SEC * stepSec)

      if (raw >= peak) {
        peak = raw
        peakAtSec = nowSec
      } else if (nowSec - peakAtSec > PEAK_HOLD_SEC) {
        // Never below the bar: a marker that had sunk into the fill would stop
        // being a marker.
        peak = Math.max(shown, peak - PEAK_FALL_PER_SEC * stepSec)
      }

      element.style.setProperty('--level', String(Math.min(1, shown)))
      element.style.setProperty('--peak', String(Math.min(1, peak)))

      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(frame)
    }
  }, [active, channelId])

  return ref
}
