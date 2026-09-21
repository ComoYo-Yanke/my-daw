import { useRef } from 'react'

type KnobProps = {
  /** Shown in the tooltip and to screen readers. */
  label: string
  value: number
  min: number
  max: number
  /** Value restored on double-click. */
  defaultValue: number
  /** Renders the value for the readout, tooltip and screen readers. */
  format: (value: number) => string
  /** Draw the value arc out from the centre rather than from the minimum. */
  bipolar?: boolean
  onChange: (value: number) => void
}

/** Sweep of the dial: 270 degrees, with the gap at the bottom. */
const START_ANGLE = -135
const END_ANGLE = 135
/** Vertical drag distance, in pixels, that covers the whole range. */
const DRAG_RANGE_PX = 150
const FINE_FACTOR = 0.25
const SIZE = 30
const RADIUS = 11

function pointOnCircle(centre: number, radius: number, angleDeg: number): { x: number; y: number } {
  // 0 degrees points up, positive angles go clockwise.
  const radians = ((angleDeg - 90) * Math.PI) / 180
  return { x: centre + radius * Math.cos(radians), y: centre + radius * Math.sin(radians) }
}

function arcPath(centre: number, radius: number, fromDeg: number, toDeg: number): string {
  if (fromDeg === toDeg) return ''
  const from = pointOnCircle(centre, radius, fromDeg)
  const to = pointOnCircle(centre, radius, toDeg)
  const largeArc = Math.abs(toDeg - fromDeg) > 180 ? 1 : 0
  const sweep = toDeg > fromDeg ? 1 : 0
  return `M ${from.x} ${from.y} A ${radius} ${radius} 0 ${largeArc} ${sweep} ${to.x} ${to.y}`
}

/**
 * A rotary control, driven by dragging vertically, arrow keys, or a
 * double-click to reset. Shift slows the drag down for fine adjustments.
 *
 * The knob is controlled: it renders `value` and reports intent through
 * `onChange`, so the store stays the single source of truth.
 */
function Knob({
  label,
  value,
  min,
  max,
  defaultValue,
  format,
  bipolar = false,
  onChange
}: KnobProps): React.JSX.Element {
  const dragRef = useRef<{ startY: number; startValue: number } | null>(null)

  const range = max - min
  const ratio = range === 0 ? 0 : (value - min) / range
  const angle = START_ANGLE + ratio * (END_ANGLE - START_ANGLE)
  const pointerEnd = pointOnCircle(SIZE / 2, RADIUS - 3, angle)
  const readout = format(value)

  const commit = (next: number): void => {
    const clamped = Math.min(max, Math.max(min, next))
    if (clamped !== value) onChange(clamped)
  }

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = { startY: event.clientY, startValue: value }
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (!drag) return
    const factor = event.shiftKey ? FINE_FACTOR : 1
    const travelled = ((drag.startY - event.clientY) / DRAG_RANGE_PX) * range * factor
    commit(drag.startValue + travelled)
  }

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    dragRef.current = null
    event.currentTarget.releasePointerCapture(event.pointerId)
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const step = (range / 100) * (event.shiftKey ? FINE_FACTOR : 1)
    if (event.key === 'ArrowUp' || event.key === 'ArrowRight') {
      event.preventDefault()
      commit(value + step)
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') {
      event.preventDefault()
      commit(value - step)
    } else if (event.key === 'Home') {
      event.preventDefault()
      commit(min)
    } else if (event.key === 'End') {
      event.preventDefault()
      commit(max)
    }
  }

  return (
    <div className="knob">
      <div
        className="knob__dial"
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={readout}
        title={`${label}：${readout}（拖动调整，双击复位，按住 Shift 微调）`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onDoubleClick={() => commit(defaultValue)}
        onKeyDown={handleKeyDown}
      >
        <svg viewBox={`0 0 ${SIZE} ${SIZE}`} width={SIZE} height={SIZE} aria-hidden="true">
          <path className="knob__track" d={arcPath(SIZE / 2, RADIUS, START_ANGLE, END_ANGLE)} />
          <path
            className="knob__value"
            d={arcPath(SIZE / 2, RADIUS, bipolar ? 0 : START_ANGLE, angle)}
          />
          <line
            className="knob__pointer"
            x1={SIZE / 2}
            y1={SIZE / 2}
            x2={pointerEnd.x}
            y2={pointerEnd.y}
          />
        </svg>
      </div>
      <span className="knob__readout">{readout}</span>
    </div>
  )
}

export default Knob
