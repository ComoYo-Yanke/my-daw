import { STEP_COUNT_OPTIONS, type StepCount } from '../types/step'

type StepCountSwitchProps = {
  value: StepCount
  onChange: (stepCount: StepCount) => void
}

/**
 * How many steps a channel's loop runs, as the row of numbers FL puts at the end
 * of the channel.
 *
 * This is how much of the grid is played, not how much of it is kept: switching
 * down hides steps rather than deleting them, so switching back up finds them
 * where they were left.
 */
function StepCountSwitch({ value, onChange }: StepCountSwitchProps): React.JSX.Element {
  return (
    <div className="step-count" role="group" aria-label="步进数">
      {STEP_COUNT_OPTIONS.map((option) => (
        <button
          key={option}
          type="button"
          className="step-count__option"
          aria-pressed={option === value}
          onClick={() => onChange(option)}
          title={`循环 ${option} 步`}
        >
          {option}
        </button>
      ))}
    </div>
  )
}

export default StepCountSwitch
