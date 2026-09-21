import ChannelSteps from './ChannelSteps'
import Knob from './Knob'
import StepCountSwitch from './StepCountSwitch'
import { useStepCursor } from '../hooks/useStepCursor'
import { selectSteps, useDawStore } from '../state/useDawStore'
import type { Channel, Playback } from '../state/useDawStore'
import type { StepCount } from '../types/step'

function formatSwing(value: number): string {
  return `${Math.round(value)}%`
}

type StepRowProps = {
  channel: Channel
  /** The transport, so this row can follow the step loop's own position. */
  playback: Playback | null
}

/**
 * One channel's steps: its name, its swing, its grid and its step count.
 *
 * The controls moved here from the channel row wholesale, and they are the same
 * controls: what a channel loops over is one subject, and it reads better as four
 * of them in a column than as a tail hanging off a mixer strip.
 *
 * A component of its own rather than a function called in a map, because every
 * row reads its own position: channels loop over their own step counts, so there
 * is no single "current step" that could be handed down from above.
 */
function StepRow({ channel, playback }: StepRowProps): React.JSX.Element {
  const setSwing = useDawStore((state) => state.setSwing)
  const setStepCount = useDawStore((state) => state.setStepCount)
  // The steps of the pattern being edited, so this window and the rack show the
  // same grid and switching pattern changes both.
  const steps = useDawStore((state) => selectSteps(state, channel.id))
  const currentStep = useStepCursor(playback, channel.id)

  return (
    <div className="steps-row">
      <span className="steps-row__name" title={channel.name}>
        {channel.name}
      </span>

      <Knob
        label="Swing"
        value={channel.swing}
        min={0}
        max={100}
        defaultValue={0}
        format={formatSwing}
        onChange={(value) => setSwing(channel.id, value)}
      />

      <ChannelSteps
        channelId={channel.id}
        steps={steps}
        stepCount={channel.stepCount}
        color={channel.color}
        currentStep={currentStep}
      />

      <StepCountSwitch
        value={channel.stepCount}
        onChange={(stepCount: StepCount) => setStepCount(channel.id, stepCount)}
      />
    </div>
  )
}

/**
 * The step sequencer, as a window of its own.
 *
 * One row per channel of the rack, in rack order, each one the grid it loops
 * over. It used to be drawn inside the channel's own row, which made the rack as
 * wide as its longest grid — 32 steps is over a thousand pixels — and put the
 * thing a pattern is *written* with in among the volume and pan the pattern is
 * only *heard* through.
 *
 * The rack and this window are two readings of the same channel: what is switched
 * on here is what the rack's `· N 步进` counts, and the transport lights the step
 * it is on in both.
 */
function StepsWindow(): React.JSX.Element {
  const channels = useDawStore((state) => state.channels)
  // Read once and passed down: every row needs it, and one subscription is
  // enough for all of them.
  const playback = useDawStore((state) => state.playback)

  return (
    <main className="content">
      {channels.length === 0 ? (
        <p className="empty">还没有通道。在 Channel Rack 里建一个，它的步进网格就会出现在这里。</p>
      ) : (
        <div className="steps-rack">
          {channels.map((channel) => (
            <StepRow key={channel.id} channel={channel} playback={playback} />
          ))}
        </div>
      )}
    </main>
  )
}

export default StepsWindow
