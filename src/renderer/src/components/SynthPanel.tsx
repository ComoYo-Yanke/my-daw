import { useMemo } from 'react'
import Knob from './Knob'
import { envelopePoints, filterResponse } from '../audio/synth'
import { useDawStore } from '../state/useDawStore'
import type { SynthChannel } from '../state/useDawStore'
import {
  DEFAULT_SYNTH_PARAMS,
  FILTER_TYPE_LABELS,
  FILTER_TYPES,
  MAX_CUTOFF_HZ,
  MAX_DETUNE_CENTS,
  MAX_ENVELOPE_SEC,
  MAX_Q,
  MAX_SUSTAIN,
  MIN_CUTOFF_HZ,
  MIN_DETUNE_CENTS,
  MIN_Q,
  MIN_SUSTAIN,
  sameSynthParams,
  SYNTH_PRESETS,
  WAVEFORM_LABELS,
  WAVEFORMS,
  type SynthParams
} from '../types/synth'

type SynthPanelProps = {
  /** Narrowed to a synth: only one of those has parameters to edit. */
  channel: SynthChannel
}

/** How an envelope time reads: milliseconds below a second, seconds above. */
function formatTime(seconds: number): string {
  if (seconds < 1) return `${Math.round(seconds * 1000)} ms`
  return `${seconds.toFixed(2)} s`
}

function formatCents(value: number): string {
  const rounded = Math.round(value)
  return `${rounded > 0 ? '+' : ''}${rounded} ¢`
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`
}

function formatHz(value: number): string {
  if (value >= 1000) return `${(value / 1000).toFixed(2)} kHz`
  return `${Math.round(value)} Hz`
}

function formatQ(value: number): string {
  return value.toFixed(1)
}

// The envelope and the filter curve are drawn rather than laid out, so both work
// in one square of SVG units and are stretched to whatever box they are given.

/** SVG units across and down both graphs. Square, so the stretch is uniform. */
const GRAPH_UNITS = 100

/**
 * How long the sustain is held for in the drawn envelope, in seconds.
 *
 * A reference, not a setting: the sustain has no length of its own — it lasts
 * as long as the note does — so the drawing has to invent one to have a shape to
 * show. What matters is that it is a fixed figure rather than a share of the
 * width, so that the graph answers "longer attack" with a longer ramp instead of
 * by rescaling everything at once.
 */
const SUSTAIN_REF_SEC = 0.4

/** Margin inside the graph, so the curve never touches the frame. */
const GRAPH_PAD_UNITS = 4

/**
 * The envelope as a path, and the x where the note is let go.
 *
 * The shape comes from `envelopePoints` — the same function the scheduler writes
 * the gain from — so what is drawn is what will be heard rather than a second
 * opinion about it. The whole envelope is fitted to the width: every segment's
 * share of the graph is its share of the time, which is what makes a pluck and a
 * pad look like the different things they are.
 *
 * The note-off mark is measured from the gate rather than taken off the end of
 * the point list, because with no release there is nothing after the gate to
 * count back past.
 */
function envelopeShape(params: SynthParams): { path: string; releaseX: number } {
  const gateSec = params.attackSec + params.decaySec + SUSTAIN_REF_SEC
  const points = envelopePoints(params, gateSec)
  const spanSec = points[points.length - 1].atSec
  const usable = GRAPH_UNITS - GRAPH_PAD_UNITS * 2

  const toX = (atSec: number): number => GRAPH_PAD_UNITS + (atSec / spanSec) * usable
  const toY = (value: number): number => GRAPH_UNITS - GRAPH_PAD_UNITS - value * usable

  const commands = points.map(
    (point, index) =>
      `${index === 0 ? 'M' : 'L'}${toX(point.atSec).toFixed(2)} ${toY(point.value).toFixed(2)}`
  )
  return { path: commands.join(' '), releaseX: toX(gateSec) }
}

/** Frequencies the filter curve is sampled at: 20Hz..20kHz, log spaced. */
const FILTER_POINTS = 160

/**
 * A filter setting as a path across the frequency axis.
 *
 * The magnitude comes from a real `BiquadFilterNode` — see `filterResponse` —
 * and is drawn in decibels on a log frequency axis, which is how a filter is
 * read: what matters is where it starts to fall and how much is left an octave
 * later, and neither of those is visible on a linear magnitude plot.
 */
function filterShape(params: SynthParams): string {
  const minLog = Math.log(MIN_CUTOFF_HZ)
  const maxLog = Math.log(MAX_CUTOFF_HZ)

  const frequencies = new Float32Array(FILTER_POINTS)
  for (let index = 0; index < FILTER_POINTS; index += 1) {
    frequencies[index] = Math.exp(minLog + ((maxLog - minLog) * index) / (FILTER_POINTS - 1))
  }
  const magnitude = filterResponse(params, frequencies)

  const usable = GRAPH_UNITS - GRAPH_PAD_UNITS * 2
  const commands: string[] = []
  for (let index = 0; index < FILTER_POINTS; index += 1) {
    const x = GRAPH_PAD_UNITS + (index / (FILTER_POINTS - 1)) * usable
    // -48dB at the bottom of the graph, +12 at the top: enough headroom for a
    // resonant peak without a quiet filter flattening into a straight line.
    const db = 20 * Math.log10(Math.max(magnitude[index], 1e-6))
    const ratio = Math.min(1, Math.max(0, (db + 48) / 60))
    const y = GRAPH_UNITS - GRAPH_PAD_UNITS - ratio * usable
    commands.push(`${index === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`)
  }
  return commands.join(' ')
}

/**
 * The synth channel's parameters, and the two pictures that make them legible.
 *
 * Every control writes through `updateSynth`, which clamps and lands the change
 * on the audio graph — and on the undo stack, as one step per gesture: a knob
 * reports the same key for every move of a drag, and a dropdown or a preset
 * reports none, which makes it a step of its own.
 *
 * Deliberately no play button. The transport belongs to the window the mouse is
 * in, and the point of this panel is to turn a knob while the part it belongs to
 * is playing — a second transport here would be a way to stop hearing the thing
 * being tuned.
 */
function SynthPanel({ channel }: SynthPanelProps): React.JSX.Element {
  const updateSynth = useDawStore((state) => state.updateSynth)
  const applySynthPreset = useDawStore((state) => state.applySynthPreset)

  const params = channel.synth
  const set = (patch: Partial<SynthParams>, key?: string): void =>
    updateSynth(channel.id, patch, key)

  const envelope = useMemo(() => envelopeShape(params), [params])
  const filter = useMemo(() => filterShape(params), [params])
  const activePreset = SYNTH_PRESETS.find((preset) => sameSynthParams(preset.params, params))?.id

  return (
    <section className="synth" aria-label="合成器参数">
      <header className="synth__header">
        <span className="synth__label">预设</span>
        {SYNTH_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            className="synth__preset"
            aria-pressed={activePreset === preset.id}
            title={preset.hint}
            onClick={() => applySynthPreset(channel.id, preset.id)}
          >
            {preset.label}
          </button>
        ))}
        <span className="synth__hint">预设只改参数，改完还能接着拧</span>
      </header>

      <div className="synth__body">
        <div className="synth__group">
          <span className="synth__label">振荡器</span>

          <label className="synth__field">
            <span className="synth__field-label">波形</span>
            <select
              className="synth__select"
              value={params.waveform}
              onChange={(event) => set({ waveform: event.target.value as SynthParams['waveform'] })}
            >
              {WAVEFORMS.map((waveform) => (
                <option key={waveform} value={waveform}>
                  {WAVEFORM_LABELS[waveform]}
                </option>
              ))}
            </select>
          </label>

          <div className="synth__field">
            <span className="synth__field-label">数量</span>
            <div className="synth__toggle">
              {([1, 2] as const).map((count) => (
                <button
                  key={count}
                  type="button"
                  className="synth__toggle-button"
                  aria-pressed={params.oscCount === count}
                  onClick={() => set({ oscCount: count })}
                  title={
                    count === 1 ? '一个振荡器' : '两个同波形的振荡器，第二个可以失谐，声音更厚'
                  }
                >
                  {count}
                </button>
              ))}
            </div>
          </div>

          <div className="synth__knob" data-off={params.oscCount === 1} title={DETUNE_HINT}>
            <Knob
              label="失谐"
              value={params.detuneCents}
              min={MIN_DETUNE_CENTS}
              max={MAX_DETUNE_CENTS}
              defaultValue={DEFAULT_SYNTH_PARAMS.detuneCents}
              format={formatCents}
              bipolar
              onChange={(value) => set({ detuneCents: value }, 'detuneCents')}
            />
          </div>
        </div>

        <div className="synth__group">
          <span className="synth__label">包络</span>

          <div className="synth__knobs">
            <Knob
              label="起音"
              value={params.attackSec}
              min={0}
              max={MAX_ENVELOPE_SEC}
              defaultValue={DEFAULT_SYNTH_PARAMS.attackSec}
              format={formatTime}
              onChange={(value) => set({ attackSec: value }, 'attackSec')}
            />
            <Knob
              label="衰减"
              value={params.decaySec}
              min={0}
              max={MAX_ENVELOPE_SEC}
              defaultValue={DEFAULT_SYNTH_PARAMS.decaySec}
              format={formatTime}
              onChange={(value) => set({ decaySec: value }, 'decaySec')}
            />
            <Knob
              label="延音"
              value={params.sustain}
              min={MIN_SUSTAIN}
              max={MAX_SUSTAIN}
              defaultValue={DEFAULT_SYNTH_PARAMS.sustain}
              format={formatPercent}
              onChange={(value) => set({ sustain: value }, 'sustain')}
            />
            <Knob
              label="释音"
              value={params.releaseSec}
              min={0}
              max={MAX_ENVELOPE_SEC}
              defaultValue={DEFAULT_SYNTH_PARAMS.releaseSec}
              format={formatTime}
              onChange={(value) => set({ releaseSec: value }, 'releaseSec')}
            />
          </div>

          <svg
            className="synth__graph"
            viewBox={`0 0 ${GRAPH_UNITS} ${GRAPH_UNITS}`}
            preserveAspectRatio="none"
            aria-hidden="true"
            focusable="false"
          >
            {/* Where the note is let go, so the release reads as a release. */}
            <line
              className="synth__graph-mark"
              x1={envelope.releaseX}
              y1="0"
              x2={envelope.releaseX}
              y2={GRAPH_UNITS}
            />
            <path className="synth__graph-line" d={envelope.path} />
          </svg>
        </div>

        <div className="synth__group">
          <span className="synth__label">滤波器</span>

          <label className="synth__field">
            <span className="synth__field-label">类型</span>
            <select
              className="synth__select"
              value={params.filterType}
              onChange={(event) =>
                set({ filterType: event.target.value as SynthParams['filterType'] })
              }
            >
              {FILTER_TYPES.map((type) => (
                <option key={type} value={type}>
                  {FILTER_TYPE_LABELS[type]}
                </option>
              ))}
            </select>
          </label>

          <div className="synth__knobs">
            {/* Cutoff is the one knob on a logarithmic scale: an octave is the
                same distance wherever it is, so the top half of the range is not
                four notes. The knob itself is linear, so the log and its inverse
                are applied here, around it. */}
            <Knob
              label="截止"
              value={Math.log(params.cutoffHz)}
              min={Math.log(MIN_CUTOFF_HZ)}
              max={Math.log(MAX_CUTOFF_HZ)}
              defaultValue={Math.log(DEFAULT_SYNTH_PARAMS.cutoffHz)}
              format={(value) => formatHz(Math.exp(value))}
              onChange={(value) => set({ cutoffHz: Math.exp(value) }, 'cutoffHz')}
            />
            <Knob
              label="共振"
              value={params.q}
              min={MIN_Q}
              max={MAX_Q}
              defaultValue={DEFAULT_SYNTH_PARAMS.q}
              format={formatQ}
              onChange={(value) => set({ q: value }, 'q')}
            />
          </div>

          <svg
            className="synth__graph"
            viewBox={`0 0 ${GRAPH_UNITS} ${GRAPH_UNITS}`}
            preserveAspectRatio="none"
            aria-hidden="true"
            focusable="false"
          >
            {/* 20Hz, 200Hz, 2kHz and 20kHz: the decades, evenly spaced on the
                log axis the curve is drawn against. */}
            {[0.25, 0.5, 0.75].map((ratio) => (
              <line
                key={ratio}
                className="synth__graph-mark"
                x1={GRAPH_PAD_UNITS + ratio * (GRAPH_UNITS - GRAPH_PAD_UNITS * 2)}
                y1="0"
                x2={GRAPH_PAD_UNITS + ratio * (GRAPH_UNITS - GRAPH_PAD_UNITS * 2)}
                y2={GRAPH_UNITS}
              />
            ))}
            <path className="synth__graph-line" d={filter} />
          </svg>
        </div>
      </div>
    </section>
  )
}

/**
 * Why the detune knob is dimmed with one oscillator.
 *
 * It still works — the number is kept and takes effect the moment a second
 * oscillator is switched on — so it is dimmed rather than taken away, and the
 * tooltip says as much instead of leaving a dead-looking control unexplained.
 */
const DETUNE_HINT = '两个振荡器之间差多少音分。只有一个振荡器时不影响声音，但数值会留着。'

export default SynthPanel
