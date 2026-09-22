// Channel effect chains: the nodes behind an `Effect`, and the chain that holds them.
//
// This module knows nothing about channels, the store or React. It is handed a
// context-in / context-out pair and a list of effects and wires one to the other.
// The context is a parameter rather than the singleton in `engine.ts`, for two
// reasons and both of them matter:
//
// - the same code serves playback and export, so an exported reverb is the reverb
//   that was heard rather than a second implementation of it to keep in step;
// - there is no import back into `engine.ts`, so `engine.ts` can import this
//   without the two modules forming a cycle.
//
// The chain is rebuilt only when its *structure* changes — a different number of
// effects, a different effect, or one switched on or off. Turning a knob writes
// into the nodes that are already there. That distinction is what makes "adjust
// it while it plays" true: a rebuild re-routes the inside of the chain, but the
// node the chain is fed from and everything already sounding into it are
// untouched, so a note halfway through is not cut and nothing is re-scheduled.
//
// Every effect is built as a black box with one input node and one output node,
// and the chain is just those boxes in a row. Two unity gains per effect is a
// price worth paying for that: it is what lets `wire` and `dispose` treat every
// effect — including ones as differently shaped as a reverb and a feedback delay
// — the same way, and it is why an effect's own fan-out never has to be known
// from the outside.
//
// No React, no store, no global: plain Web Audio.

import {
  MAX_DELAY_SEC,
  type DelayParams,
  type DistortionParams,
  type Effect,
  type ReverbParams
} from '../types/effect'

/** What a caller can do with a chain once it has one. */
export type EffectChain = {
  /**
   * Move to a new list of effects.
   *
   * Cheap when only parameters changed — which is every frame of a knob drag —
   * and a rebuild when the list itself did.
   */
  apply: (effects: Effect[]) => void
  /** Take the whole chain apart. */
  dispose: () => void
}

type ReverbEffect = Extract<Effect, { type: 'reverb' }>
type DelayEffect = Extract<Effect, { type: 'delay' }>
type DistortionEffect = Extract<Effect, { type: 'distortion' }>

/**
 * One built effect: its nodes, and enough state to know what is already loaded
 * into them.
 *
 * `kind` is the effect's type, carried on the slot rather than looked up,
 * because the chain has to answer "is this the same effect it was?" without
 * reaching back into the store's list.
 */
type ReverbSlot = {
  kind: 'reverb'
  id: string
  input: GainNode
  output: GainNode
  dry: GainNode
  wet: GainNode
  convolver: ConvolverNode
  /**
   * Which impulse response is loaded, in quantized steps.
   *
   * The steps are the whole point: a drag of the room-size knob crosses a couple
   * of dozen values, not one per frame, and only a crossing is worth the few
   * milliseconds of generating three seconds of stereo noise.
   */
  roomStep: number
  dampingStep: number
}

type DelaySlot = {
  kind: 'delay'
  id: string
  input: GainNode
  output: GainNode
  dry: GainNode
  wet: GainNode
  delay: DelayNode
  feedback: GainNode
}

type DistortionSlot = {
  kind: 'distortion'
  id: string
  input: GainNode
  output: GainNode
  shaper: WaveShaperNode
  tone: BiquadFilterNode
  level: GainNode
  /** Which curve is loaded, same idea as the reverb's steps. */
  driveStep: number
}

type Slot = ReverbSlot | DelaySlot | DistortionSlot

/**
 * Time constant for a level change, in seconds.
 *
 * Matches `engine.ts`'s own ramp: short enough to read as instant, long enough
 * that a gain does not step and click.
 */
const MIX_RAMP_SEC = 0.01

/**
 * Time constant for a delay time change — deliberately longer than the others.
 *
 * A delay time is not a level; moving it is a resampling of whatever is in the
 * line, and stepping it instantly is heard as a click or a pitch jump. Sliding
 * over about fifty milliseconds is the difference between "the repeats moved"
 * and "the repeats tore".
 */
const TIME_RAMP_SEC = 0.05

/** Move a parameter to a new value over a ramp. */
function ramp(param: AudioParam, value: number, atSec: number, timeConstant: number): void {
  param.cancelScheduledValues(atSec)
  param.setTargetAtTime(value, atSec, timeConstant)
}

/** A unity gain: a named point in the graph, not a change of level. */
function unityGain(context: BaseAudioContext): GainNode {
  const node = context.createGain()
  node.gain.value = 1
  return node
}

// --- Reverb -----------------------------------------------------------------

/** Shortest and longest impulse response, in seconds, at room size 0 and 1. */
const MIN_IR_SEC = 0.12
const MAX_IR_SEC = 3

/**
 * How far the tail has fallen by the end of the impulse response, in nepers.
 *
 * ln(0.001) ≈ -6.9, so the response runs down 60dB over its length — the
 * conventional definition of a reverb's decay time, and what makes "room size"
 * mean something a listener can hear rather than an arbitrary length.
 */
const IR_DECAY_NEPERS = -6.9

/**
 * The deepest the damping one-pole can go, as a share of its range.
 *
 * At damping 1 the coefficient is 0.1 rather than 0, because a coefficient of 0
 * freezes the filter's state and the tail would become a constant offset instead
 * of fading noise.
 */
const DAMPING_DEPTH = 0.9

/**
 * Fixed seed for the impulse response's noise.
 *
 * Fixed, and not derived from the parameters, so that the same settings always
 * produce the same impulse response. That is what lets an export match a
 * playback: the two generate the reverb independently, in different processes
 * even, and a random seed would make them two different rooms.
 */
const IR_SEED = 0x1f123bb5

/** Steps the room size and damping are quantized to before regenerating. */
const ROOM_STEPS = 24
const DAMPING_STEPS = 12

/**
 * A deterministic noise source.
 *
 * xorshift32: three shifts and three xors per sample, which is about as little
 * as a noise generator can cost while still being flat enough to sound like a
 * room rather than a tone. `Math.random` would be shorter to write and would be
 * the one thing in this file that made an export differ from a playback.
 */
function noiseSource(seed: number): () => number {
  let state = seed
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    // Back to unsigned before scaling: the shifts leave an int32, which is
    // negative half the time, and a negative sample would flip the waveform.
    return ((state >>> 0) / 4294967296) * 2 - 1
  }
}

/**
 * Build an impulse response: noise, low-passed, under an exponential decay.
 *
 * Two channels generated separately, which is the whole of the stereo width — a
 * single channel convolved into both ears is a reverb that sounds like it is
 * inside your head.
 *
 * Two details are load-bearing rather than incidental:
 *
 * - The decaying envelope is an incrementally multiplied constant, not
 *   `Math.pow` per sample. Three seconds of stereo noise is a quarter of a
 *   million samples and a power call in that loop is the difference between a
 *   knob that sticks and one that does not.
 * - The finished response is scaled so its total energy is 1. Without that,
 *   `wet` would not be a mix ratio: a bigger room would also be a louder one,
 *   and the one knob would be two.
 */
function createImpulseResponse(
  context: BaseAudioContext,
  roomSize: number,
  damping: number
): AudioBuffer {
  const sampleRate = context.sampleRate
  const lengthSec = MIN_IR_SEC + roomSize * (MAX_IR_SEC - MIN_IR_SEC)
  const frames = Math.max(1, Math.round(lengthSec * sampleRate))
  const buffer = context.createBuffer(2, frames, sampleRate)

  const decay = Math.exp(IR_DECAY_NEPERS / frames)
  const smoothing = 1 - damping * DAMPING_DEPTH

  let energy = 0
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel)
    const noise = noiseSource(IR_SEED + channel)
    // A one-pole low-pass on the noise, which is what damping is: the tail's
    // high frequencies die first and the room gets darker as it is turned up.
    let tone = 0
    let envelope = 1
    for (let frame = 0; frame < frames; frame += 1) {
      tone += (noise() - tone) * smoothing
      const value = tone * envelope
      data[frame] = value
      energy += value * value
      envelope *= decay
    }
  }

  if (energy > 0) {
    const scale = 1 / Math.sqrt(energy)
    for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
      const data = buffer.getChannelData(channel)
      for (let frame = 0; frame < frames; frame += 1) {
        data[frame] *= scale
      }
    }
  }

  return buffer
}

function quantize(value: number, steps: number): number {
  return Math.round(value * steps) / steps
}

function buildReverb(context: BaseAudioContext, effect: ReverbEffect): ReverbSlot {
  const params = effect.params
  const input = unityGain(context)
  const output = unityGain(context)
  const dry = context.createGain()
  const wet = context.createGain()
  const convolver = context.createConvolver()

  // The impulse response is normalized to unit energy above, so the convolver's
  // own normalization would be a second scaling on top of it — and one computed
  // from a different definition of "loud", which would put the wet level back in
  // the hands of the room size.
  convolver.normalize = false

  // Set at build time rather than left at the node default of 1, because an
  // offline render starts at time 0: a mix that had to ramp up from 1/1 in the
  // first fifty milliseconds would fade the beginning of an exported file in.
  dry.gain.value = 1 - params.wet
  wet.gain.value = params.wet

  const roomStep = quantize(params.roomSize, ROOM_STEPS)
  const dampingStep = quantize(params.damping, DAMPING_STEPS)
  convolver.buffer = createImpulseResponse(context, roomStep, dampingStep)

  input.connect(dry)
  dry.connect(output)
  input.connect(convolver)
  convolver.connect(wet)
  wet.connect(output)

  return {
    kind: 'reverb',
    id: effect.id,
    input,
    output,
    dry,
    wet,
    convolver,
    roomStep,
    dampingStep
  }
}

function writeReverb(context: BaseAudioContext, slot: ReverbSlot, params: ReverbParams): void {
  const now = context.currentTime
  ramp(slot.wet.gain, params.wet, now, MIX_RAMP_SEC)
  ramp(slot.dry.gain, 1 - params.wet, now, MIX_RAMP_SEC)

  const roomStep = quantize(params.roomSize, ROOM_STEPS)
  const dampingStep = quantize(params.damping, DAMPING_STEPS)
  if (roomStep === slot.roomStep && dampingStep === slot.dampingStep) return

  slot.roomStep = roomStep
  slot.dampingStep = dampingStep
  slot.convolver.buffer = createImpulseResponse(context, roomStep, dampingStep)
}

// --- Delay ------------------------------------------------------------------

function buildDelay(context: BaseAudioContext, effect: DelayEffect): DelaySlot {
  const params = effect.params
  const input = unityGain(context)
  const output = unityGain(context)
  const dry = context.createGain()
  const wet = context.createGain()
  const delay = context.createDelay(MAX_DELAY_SEC)
  const feedback = context.createGain()

  dry.gain.value = 1 - params.wet
  wet.gain.value = params.wet
  delay.delayTime.value = params.timeSec
  feedback.gain.value = params.feedback

  input.connect(dry)
  dry.connect(output)
  input.connect(delay)
  delay.connect(wet)
  wet.connect(output)
  // The repeats: the output of the line fed back into its own input. Web Audio
  // only permits a cycle that passes through a DelayNode, which is exactly what
  // this is — the delay is the reason the loop is legal, not incidental to it.
  delay.connect(feedback)
  feedback.connect(delay)

  return { kind: 'delay', id: effect.id, input, output, dry, wet, delay, feedback }
}

function writeDelay(context: BaseAudioContext, slot: DelaySlot, params: DelayParams): void {
  const now = context.currentTime
  ramp(slot.wet.gain, params.wet, now, MIX_RAMP_SEC)
  ramp(slot.dry.gain, 1 - params.wet, now, MIX_RAMP_SEC)
  ramp(slot.feedback.gain, params.feedback, now, MIX_RAMP_SEC)
  ramp(slot.delay.delayTime, params.timeSec, now, TIME_RAMP_SEC)
}

// --- Distortion -------------------------------------------------------------

/** Points in the waveshaper's curve. */
const CURVE_SAMPLES = 2048

/**
 * How hard a drive of 1 bites, on the arbitrary 0..100 scale the curve is
 * usually quoted at.
 */
const DRIVE_SCALE = 100

/** Steps the drive is quantized to before the curve is rebuilt. */
const DRIVE_STEPS = 64

/**
 * Q of the tone filter: 1/√2, the value at which a second-order lowpass is
 * maximally flat.
 *
 * A `BiquadFilterNode` defaults to 1, which is not the same filter — it has a
 * resonant peak right at the corner. That would make 音调 a knob that pushes
 * some frequencies up as it takes others down, which is not what the label
 * says it does.
 */
const BUTTERWORTH_Q = Math.SQRT1_2

/**
 * The shaping curve: `(3 + k)·x·20·deg / (π + k|x|)`.
 *
 * That formula is the familiar one, and at k = 0 it collapses to x/3 — a
 * distortion at zero drive would be a *quieter* copy of the signal, which makes
 * A/B-ing an effect impossible to do honestly. The extra 3 puts that back, so
 * drive 0 is the identity map and a distortion that is switched on but not
 * driven is not a change of sound.
 *
 * The same property is why the curve is applied whole rather than as a small
 * correction on top: this is a shaper, and what comes out is what the formula
 * says, including the part where it lifts quiet signals rather than only
 * squashing loud ones.
 */
function distortionCurve(drive: number): Float32Array<ArrayBuffer> {
  const k = drive * DRIVE_SCALE
  const curve = new Float32Array(CURVE_SAMPLES)
  const deg = Math.PI / 180

  for (let index = 0; index < CURVE_SAMPLES; index += 1) {
    // -1..1 inclusive: the range a waveshaper is defined over, and beyond which
    // it holds the end values.
    const x = (index * 2) / (CURVE_SAMPLES - 1) - 1
    curve[index] = ((3 + k) * x * 20 * deg * 3) / (Math.PI + k * Math.abs(x))
  }

  return curve
}

function buildDistortion(context: BaseAudioContext, effect: DistortionEffect): DistortionSlot {
  const params = effect.params
  const input = unityGain(context)
  const output = unityGain(context)
  const shaper = context.createWaveShaper()
  const tone = context.createBiquadFilter()
  const level = context.createGain()

  // Oversampled, because shaping a curve generates harmonics above half the
  // sample rate and those fold back down as inharmonic tones. Four times is the
  // cheapest setting that moves the fold-back somewhere the tone control can
  // take care of it.
  shaper.oversample = '4x'
  const driveStep = quantize(params.drive, DRIVE_STEPS)
  shaper.curve = distortionCurve(driveStep)

  tone.type = 'lowpass'
  tone.frequency.value = params.toneHz
  // Butterworth rather than the node's default Q of 1: a tone control should
  // take the top off and leave the rest where it was, and at Q 1 there is a
  // resonant bump at the corner — a "tone" knob that boosted as well as cut
  // would be a filter wearing the wrong label.
  tone.Q.value = BUTTERWORTH_Q

  level.gain.value = params.outputGain

  input.connect(shaper)
  shaper.connect(tone)
  tone.connect(level)
  level.connect(output)

  return {
    kind: 'distortion',
    id: effect.id,
    input,
    output,
    shaper,
    tone,
    level,
    driveStep
  }
}

function writeDistortion(
  context: BaseAudioContext,
  slot: DistortionSlot,
  params: DistortionParams
): void {
  const now = context.currentTime
  ramp(slot.tone.frequency, params.toneHz, now, MIX_RAMP_SEC)
  ramp(slot.level.gain, params.outputGain, now, MIX_RAMP_SEC)

  const driveStep = quantize(params.drive, DRIVE_STEPS)
  if (driveStep === slot.driveStep) return

  slot.driveStep = driveStep
  slot.shaper.curve = distortionCurve(driveStep)
}

// --- The chain --------------------------------------------------------------

function buildSlot(context: BaseAudioContext, effect: Effect): Slot {
  switch (effect.type) {
    case 'reverb':
      return buildReverb(context, effect)
    case 'delay':
      return buildDelay(context, effect)
    case 'distortion':
      return buildDistortion(context, effect)
  }
}

function disposeSlot(slot: Slot): void {
  // The slot's own output is let go of too: it is the edge to whatever comes
  // next in the chain, and leaving it would keep a torn-down effect audible.
  slot.input.disconnect()
  slot.output.disconnect()
  switch (slot.kind) {
    case 'reverb':
      slot.dry.disconnect()
      slot.wet.disconnect()
      slot.convolver.disconnect()
      break
    case 'delay':
      slot.dry.disconnect()
      slot.wet.disconnect()
      slot.delay.disconnect()
      slot.feedback.disconnect()
      break
    case 'distortion':
      slot.shaper.disconnect()
      slot.tone.disconnect()
      slot.level.disconnect()
      break
  }
}

/**
 * Write a new set of parameters into a slot that is already built.
 *
 * The two conditions on each branch are the same check twice: a slot only ever
 * holds the effect that built it, and `sameStructure` sends every other case
 * down the rebuild path — so the branch that matches is the branch that runs.
 * Written as a matched pair rather than a switch on the effect followed by a
 * cast, because the pairing is the thing being asserted and the cast would hide
 * it. Falling through matches nothing, which is the correct answer for a state
 * that cannot arise.
 */
function writeParams(context: BaseAudioContext, slot: Slot, effect: Effect): void {
  if (slot.kind === 'reverb' && effect.type === 'reverb') {
    writeReverb(context, slot, effect.params)
  } else if (slot.kind === 'delay' && effect.type === 'delay') {
    writeDelay(context, slot, effect.params)
  } else if (slot.kind === 'distortion' && effect.type === 'distortion') {
    writeDistortion(context, slot, effect.params)
  }
}

/**
 * Whether a chain can absorb a new list of effects without being rebuilt.
 *
 * Only the things a rebuild would change: how many, which ones, and whether each
 * is switched on. Bypassed effects are not built at all, so finding one in the
 * list is itself a difference — which is what makes switching one off a rebuild
 * and turning its knob a write.
 */
function sameStructure(slots: Slot[], effects: Effect[]): boolean {
  if (slots.length !== effects.length) return false
  for (let index = 0; index < slots.length; index += 1) {
    const effect = effects[index]
    if (!effect.enabled) return false
    if (slots[index].id !== effect.id || slots[index].kind !== effect.type) return false
  }
  return true
}

export function createEffectChain(
  context: BaseAudioContext,
  input: AudioNode,
  output: AudioNode,
  effects: Effect[]
): EffectChain {
  let slots: Slot[] = []

  /** Run the slots in a row, from the chain's input to the chain's output. */
  const wire = (): void => {
    input.disconnect()
    let previous: AudioNode = input
    for (const slot of slots) {
      previous.connect(slot.input)
      previous = slot.output
    }
    previous.connect(output)
  }

  const rebuild = (next: Effect[]): void => {
    for (const slot of slots) disposeSlot(slot)
    slots = next.filter((effect) => effect.enabled).map((effect) => buildSlot(context, effect))
    wire()
  }

  rebuild(effects)

  return {
    apply: (next: Effect[]): void => {
      if (!sameStructure(slots, next)) {
        rebuild(next)
        return
      }
      for (let index = 0; index < next.length; index += 1) {
        writeParams(context, slots[index], next[index])
      }
    },
    dispose: (): void => {
      for (const slot of slots) disposeSlot(slot)
      slots = []
      input.disconnect()
    }
  }
}
