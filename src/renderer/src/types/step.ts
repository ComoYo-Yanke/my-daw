// Step sequencer data and loop timing.
//
// A grid is a plain on/off mask, which is what FL's channel rack is: a step
// either fires the channel's sample or it does not. Everything else here is the
// loop's clock — when a step fires, how long a hit rings, and how much swing
// pushes the off-beat steps late.

import { secondsPerStep } from './note'

/** The step counts a channel can be set to. */
export const STEP_COUNT_OPTIONS = [4, 8, 16, 32] as const
export type StepCount = (typeof STEP_COUNT_OPTIONS)[number]
export const DEFAULT_STEP_COUNT: StepCount = 16
/** The longest grid, and therefore the length every stored grid is kept at. */
export const MAX_STEP_COUNT = 32

/**
 * One channel's step grid.
 *
 * Always `MAX_STEP_COUNT` long, whatever the channel's step count is. The count
 * decides how much of the grid is shown and played, not how much of it is kept,
 * which is what lets a channel shrink to 4 steps and grow back to 16 without
 * having thrown away everything in between.
 */
export type StepGrid = boolean[]

/** A grid with nothing switched on. Shared, and never written to. */
export const EMPTY_STEPS: StepGrid = emptySteps()

export function emptySteps(): StepGrid {
  return Array.from({ length: MAX_STEP_COUNT }, () => false)
}

/** The same grid with one step flipped. Returns a new grid; the input is untouched. */
export function withStepToggled(grid: StepGrid, step: number): StepGrid {
  const next = [...grid]
  next[step] = !next[step]
  return next
}

/** Whether any step the channel is playing is switched on. */
export function hasSteps(grid: StepGrid, stepCount: number): boolean {
  return grid.slice(0, stepCount).some(Boolean)
}

/** One pass of the loop, in seconds. */
export function stepSequenceSec(stepCount: number, bpm: number): number {
  return stepCount * secondsPerStep(bpm)
}

/**
 * How late swing pushes a step, in seconds.
 *
 * Off-beat steps only — the ones at odd indices, which are the 2nd, 4th, 6th…
 * of the bar when you count from one the way a drummer does. 100% puts them half
 * a step late, which is as far as they can go before landing on the next step.
 */
function swingLateSec(index: number, swing: number, bpm: number): number {
  if (index % 2 === 0) return 0
  return (swing / 100) * (secondsPerStep(bpm) / 2)
}

/** When a step starts, in seconds from the top of the pass. */
export function stepStartSec(index: number, swing: number, bpm: number): number {
  return index * secondsPerStep(bpm) + swingLateSec(index, swing, bpm)
}

/**
 * Time from the start of one step to the start of the next, swing included.
 *
 * A step that is running late shortens the step before it and lengthens the one
 * after, so the pass stays the same length however much swing is dialled in.
 */
export function stepGapSec(fromIndex: number, toIndex: number, swing: number, bpm: number): number {
  return (
    secondsPerStep(bpm) + swingLateSec(toIndex, swing, bpm) - swingLateSec(fromIndex, swing, bpm)
  )
}

/**
 * The next step after `from` that fires, wrapping into the next pass.
 *
 * Callers only ask about a step that fires, so the search always finds at least
 * `from` itself and never comes back empty.
 */
export function nextFiringStep(grid: StepGrid, from: number, stepCount: number): number {
  for (let ahead = 1; ahead <= stepCount; ahead += 1) {
    const index = (from + ahead) % stepCount
    if (grid[index] === true) return index
  }
  return from
}

/**
 * How long a hit rings: until the step that takes it over, or all the way round to
 * itself when nothing else fires.
 *
 * The wrap is the whole point. A lone step is cut by its own next pass, which
 * stops it ringing forever and stacking a voice on itself every loop. Swing is in
 * here too, because a step is cut by when the next hit *starts*, not by a fixed
 * length.
 */
export function hitLengthSec(
  from: number,
  target: number,
  stepCount: number,
  swing: number,
  bpm: number
): number {
  let index = from
  let total = 0
  do {
    const next = (index + 1) % stepCount
    total += stepGapSec(index, next, swing, bpm)
    index = next
  } while (index !== target)
  return total
}

/** Which step is showing `elapsedSec` into a pass. */
export function stepAtSec(
  elapsedSec: number,
  stepCount: number,
  swing: number,
  bpm: number
): number {
  let index = 0
  while (index + 1 < stepCount && stepStartSec(index + 1, swing, bpm) <= elapsedSec) {
    index += 1
  }
  return index
}

/**
 * Where the loop picks up at `atSec` to stay in phase with a pass that began at
 * `startedAtSec`.
 *
 * Only needed when a channel is switched on part way through: starting it at its
 * own step one would put it a beat out from the channels already running.
 */
export function loopCursorAt(
  atSec: number,
  startedAtSec: number,
  stepCount: number,
  swing: number,
  bpm: number
): { index: number; atSec: number } {
  const passSec = stepSequenceSec(stepCount, bpm)
  const elapsedSec = Math.max(0, atSec - startedAtSec)
  let passStartSec = startedAtSec + Math.floor(elapsedSec / passSec) * passSec
  // The step showing now is already under way, so the next reservation is the one
  // after it.
  const index = (stepAtSec(elapsedSec % passSec, stepCount, swing, bpm) + 1) % stepCount
  if (index === 0) passStartSec += passSec
  return { index, atSec: passStartSec + stepStartSec(index, swing, bpm) }
}
