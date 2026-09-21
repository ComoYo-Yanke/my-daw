import { useDawStore } from '../state/useDawStore'
import { STEPS_PER_BEAT } from '../types/note'
import type { StepGrid } from '../types/step'

type ChannelStepsProps = {
  channelId: string
  steps: StepGrid
  /** How many of the grid's steps this channel loops over. */
  stepCount: number
  /** What this channel's switched-on steps are filled with. */
  color: string
  /** The step that is sounding, or null when the loop is not running. */
  currentStep: number | null
}

/**
 * One channel's steps: a bar of 1/16 notes, one cell each.
 *
 * A step is a switch, not a pad — clicking it decides whether the loop fires the
 * sample when it passes, and nothing sounds until the transport reaches it.
 * Auditioning the sample is the waveform's job.
 *
 * Only `stepCount` cells are drawn, and a group gap lands every four of them, so
 * the rack reads in beats: four cells to a beat, four beats to a bar.
 */
function ChannelSteps({
  channelId,
  steps,
  stepCount,
  color,
  currentStep
}: ChannelStepsProps): React.JSX.Element {
  const toggleStep = useDawStore((state) => state.toggleStep)

  return (
    <div
      className="steps"
      role="group"
      aria-label={`${stepCount} 步进音序器`}
      // Read by the cells' filled state, so the channel's colour stays in one
      // place instead of being threaded through every cell's style.
      style={{ '--step-color': color } as React.CSSProperties}
    >
      {/* Indexed off the channel's own step count rather than the grid's length,
          which is always the maximum so that shrinking keeps the steps it hides. */}
      {Array.from({ length: stepCount }, (_, index) => (
        <button
          key={index}
          type="button"
          className="step"
          aria-pressed={steps[index] === true}
          data-beat={index % STEPS_PER_BEAT === 0}
          data-current={index === currentStep}
          onClick={() => toggleStep(channelId, index)}
          title={`第 ${index + 1} 步`}
          aria-label={`第 ${index + 1} 步`}
        />
      ))}
    </div>
  )
}

export default ChannelSteps
