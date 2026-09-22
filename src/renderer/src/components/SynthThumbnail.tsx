import type { Waveform } from '../types/synth'

type SynthThumbnailProps = {
  waveform: Waveform
  /** Drawn as two overlapping traces, the way two oscillators actually sound. */
  oscCount: 1 | 2
  isPlaying: boolean
}

/** How finely one cycle is traced. Enough that the curves read as curves. */
const SAMPLES_PER_CYCLE = 64

/** Cycles drawn across the button. Two is what shows a period *and* a repeat. */
const CYCLES = 2

/**
 * One cycle of a waveform, phase 0..1, value -1..1.
 *
 * The three with corners are written as Web Audio writes them, which is worth
 * being exact about because this is the whole of what the thumbnail claims: the
 * triangle starts at zero and rises, and the sawtooth falls from the top of the
 * cycle to the bottom, so what is drawn is what the oscillator is doing rather
 * than a generic picture of the name.
 */
function waveValue(waveform: Waveform, phase: number): number {
  const p = phase - Math.floor(phase)
  switch (waveform) {
    case 'sine':
      return Math.sin(p * Math.PI * 2)
    case 'square':
      return p < 0.5 ? 1 : -1
    case 'sawtooth':
      return 1 - 2 * p
    case 'triangle':
      return p < 0.25 ? 4 * p : p < 0.75 ? 2 - 4 * p : 4 * p - 4
  }
}

/**
 * The points of one trace, in the 0..100 square the SVG is drawn in.
 *
 * A step of more than one unit between neighbours is a corner, not a slope, and
 * gets a second point at the same x so the corner is drawn square. Without it a
 * square wave would come out as a zigzag, which is a picture of neither a square
 * nor anything that could be heard.
 */
function tracePath(waveform: Waveform, offsetUnits: number): string {
  const total = SAMPLES_PER_CYCLE * CYCLES
  const commands: string[] = []
  const push = (x: number, value: number): void => {
    const px = (x / total) * 100
    const py = 50 - (value * 42 + offsetUnits)
    commands.push(`${commands.length === 0 ? 'M' : 'L'}${px.toFixed(2)} ${py.toFixed(2)}`)
  }

  let previous = waveValue(waveform, 0)
  push(0, previous)
  for (let index = 1; index <= total; index += 1) {
    const value = waveValue(waveform, index / SAMPLES_PER_CYCLE)
    if (Math.abs(value - previous) > 1) push(index, previous)
    push(index, value)
    previous = value
  }
  return commands.join(' ')
}

/**
 * Draws a synth channel's waveform, where a sampler's row draws its peaks.
 *
 * A bare SVG rather than a canvas like `WaveformThumbnail`, because there is no
 * data underneath this: the shape is a function of one enum, so there is nothing
 * to measure and nothing to redraw on resize. It is stretched to whatever box the
 * row gives it.
 *
 * A second oscillator is drawn as a second trace, a hair apart and dimmer. The
 * two are the same waveform at the same frequency with a few cents between them,
 * so they would overlap almost exactly — which is the point of drawing both, and
 * of drawing the detune as a small offset rather than at its true size.
 */
function SynthThumbnail({ waveform, oscCount, isPlaying }: SynthThumbnailProps): React.JSX.Element {
  const color = isPlaying ? '#6c8cff' : '#8d97b5'
  return (
    <svg
      className="synth-wave"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      <line x1="0" y1="50" x2="100" y2="50" stroke={color} strokeOpacity="0.25" />
      {oscCount === 2 && (
        <path
          d={tracePath(waveform, 6)}
          fill="none"
          stroke={color}
          strokeOpacity="0.45"
          strokeWidth="4"
          vectorEffect="non-scaling-stroke"
        />
      )}
      <path
        d={tracePath(waveform, oscCount === 2 ? -6 : 0)}
        fill="none"
        stroke={color}
        strokeWidth="6"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}

export default SynthThumbnail
