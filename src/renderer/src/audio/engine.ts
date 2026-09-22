// Audio engine — the single owner of the AudioContext and of every audio node.
//
// Rules this module exists to enforce (see CLAUDE.md):
// - exactly one AudioContext, created lazily on the first user gesture
// - every time value is seconds, read from AudioContext.currentTime
// - audio is scheduled on the audio clock, never with setInterval/setTimeout
//
// Graph, per channel:
//
//   source -> GainNode -> [GainNode] -> GainNode -> [effects] -> GainNode
//  (per voice) (velocity)   (curve)     (strip input)          (per channel)
//                                          -> StereoPannerNode -> masterGain
//                                                                    (app-wide)
//
// The strip's input gain is where every voice of a channel arrives, and it is a
// node of its own rather than the channel's fader so that the effect chain has
// somewhere to be inserted. Rebuilding the chain therefore disconnects nothing
// that is currently sounding: the input is upstream of everything the chain
// touches, so a note halfway through a reverb keeps going while the reverb
// underneath it is replaced.
//
// The master gain is the app's own output level rather than a channel's: it sits
// after every strip, so turning it down turns everything down together and leaves
// each channel's own volume, pan and mute exactly where they were.
//
// The curve gain is the odd one out: it is built only for a note that came from a
// clip carrying a volume curve, so a pattern, a step grid and a song of plain
// clips all run the original two-node chain. Where it exists it multiplies with
// the velocity gain rather than replacing it, which is what keeps a note's own
// velocity and its clip's automation two separate things that happen to meet.
//
// The channel's gain and panner outlive individual voices on purpose: a
// channel's volume, pan, mute and solo must be audible *immediately*, including
// on a voice that is already sounding. The first gain is the note's own, and
// exists because velocity belongs to a note rather than to the channel. Only the
// source node is created per trigger, because AudioBufferSourceNode is
// single-use by spec.
//
// Pitch is not a playback rate. A source playing at 2x is not the same note an
// octave up — it is the same note played twice as fast, so it also ends twice as
// early, and a note's length would then depend on its pitch. Every voice here
// therefore plays at rate 1 and sounds whatever `pitchShiftedBuffer` handed it:
// a copy of the sample re-pitched ahead of time, of its original length. How long
// it is heard for is then the note's own business and nothing else: the length it
// was drawn at, plus the tail it carries — see `soundingSec`.
//
// No React and no store access here: this is plain Web Audio.

import { SimpleFilter, SoundTouch } from 'soundtouchjs'

import { createEffectChain, type EffectChain } from './effects'
import { curveValueAt, type CurvePoint } from '../types/curve'
import type { Effect } from '../types/effect'
import { soundingSec, type Note } from '../types/note'
import { voiceForPitch, type SampleZone } from '../types/sample'

let audioContext: AudioContext | null = null

/** The shared AudioContext, created on first use. */
export function getAudioContext(): AudioContext {
  if (!audioContext) {
    audioContext = new AudioContext()
  }
  return audioContext
}

/**
 * An AudioContext starts suspended until a user gesture. Call this from inside a
 * click handler before decoding or playing, or the first sound will be silent.
 */
export async function resumeAudioContext(): Promise<void> {
  const context = getAudioContext()
  if (context.state !== 'running') {
    await context.resume()
  }
}

/**
 * The bytes of a `Uint8Array` as a standalone `ArrayBuffer`.
 *
 * A `Uint8Array` is a window onto a buffer that may be larger than the view and
 * may be shared, so handing `bytes.buffer` straight to `decodeAudioData` would
 * hand it whatever else lives alongside. This copies the window out exactly.
 */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

/**
 * Decode a file's bytes into an AudioBuffer.
 *
 * The Web Audio API *transfers* (detaches) the passed ArrayBuffer, so the caller
 * must not reuse it afterwards. Only the returned AudioBuffer is kept.
 */
export async function decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer> {
  return getAudioContext().decodeAudioData(data)
}

/**
 * One sounding voice.
 *
 * A voice is not just its source node: a note's velocity needs a gain of its
 * own, and that node has to be torn down with the voice it was built for. Both
 * live here so `stopStrip` cuts a voice whole.
 */
type Voice = {
  /**
   * What is making the sound, and what gets stopped to cut it.
   *
   * Wide enough for either instrument: a sampler's `AudioBufferSourceNode` and a
   * synth's `OscillatorNode` are both scheduled sources, and both are started and
   * stopped by time and report `onended`. What the strip does with a voice —
   * track it, cut it, wait for the last one — it does through this and nothing
   * narrower, which is why it does not have to know which kind it is holding.
   */
  source: AudioScheduledSourceNode
  /** Nodes this voice owns alone, disconnected when it ends or is cut. */
  tail: AudioNode[]
}

/**
 * A channel's mixer strip: the persistent gain and panner for one channel, plus
 * the voices currently sounding through it.
 */
export type ChannelStrip = {
  /**
   * Where every voice of this channel arrives, and where the effect chain is
   * inserted.
   *
   * Unity, and not the channel's volume: volume, mute and solo are the `gain`
   * below, which sits *after* the effects. That ordering is what makes a fader
   * a fader — it turns the channel down along with the reverb tail it produced —
   * and it is also why the chain can be rebuilt without touching anything that
   * is currently sounding.
   */
  input: GainNode
  gain: GainNode
  panner: StereoPannerNode
  /**
   * What the channel is putting out right now, for a meter to read.
   *
   * Last in the chain on purpose: after the fader and the panner, so a bar fed
   * from it shows what this channel contributes to the mix rather than what its
   * notes asked for. A voice reserved ahead of the clock produces silence until
   * its moment comes, and this reads the silence, which is the honest answer.
   */
  analyser: AnalyserNode
  /** This channel's effect chain. Empty until the mix is applied. */
  effects: EffectChain
  voices: Set<Voice>
  /** Called on the silent <-> sounding edges, so the UI can light an indicator. */
  onActiveChange: (active: boolean) => void
}

const strips = new Map<string, ChannelStrip>()

/**
 * The app's output level, applied to everything at once.
 *
 * Built on first use and then kept, because the context is created lazily on a
 * user gesture. This is the one node that belongs to the application rather than
 * to a channel or a project, so nothing ever rebuilds or reconnects it: strips
 * come and go with the rack, and this outlives all of them.
 */
let masterGain: GainNode | null = null

/**
 * Time constant for parameter changes, in seconds. Small enough to feel
 * instant, large enough that jumps in gain or pan do not click.
 */
const RAMP_SEC = 0.01

/**
 * Fade applied to the front of every note, in seconds.
 *
 * A recording does not have to begin at zero — a chopped one-shot usually does
 * not — and a source that starts on a non-zero frame steps the output from
 * silence to that value within one frame, which is heard as a click. Rising from
 * silence instead costs a few milliseconds and is far too short to be heard as
 * an attack, so nothing about how the sample sounds is lost.
 */
export const VOICE_FADE_IN_SEC = 0.005

/**
 * Fade applied where a note stops a sample short, in seconds.
 *
 * A note shorter than the recording it plays is cut mid-signal by the source's
 * own `stop`, and the output steps from wherever the waveform had got to, back
 * to zero — the truncation click, and at its worst on a natural decay, which is
 * still moving when it is cut. Long enough to ramp that step away, short enough
 * that the note still ends where it was asked to end.
 *
 * Only applied where there is something to release; see `scheduleNoteSequence`.
 */
export const VOICE_FADE_OUT_SEC = 0.005

/**
 * How much of the output a meter reads at once, in samples.
 *
 * About forty milliseconds, which is longer than a frame: a meter that read
 * exactly one frame's worth would be free to step over a short transient
 * entirely and so under-report the one thing it exists to show. Longer than this
 * and the bar would be describing a moment that has already gone by.
 */
const METER_WINDOW_FRAMES = 2048

/** Build and connect a channel strip. Gain starts silent until the mix is applied. */
export function createStrip(
  channelId: string,
  onActiveChange: (active: boolean) => void
): ChannelStrip {
  const context = getAudioContext()

  const input = context.createGain()
  const gain = context.createGain()
  const panner = context.createStereoPanner()
  const analyser = context.createAnalyser()
  analyser.fftSize = METER_WINDOW_FRAMES
  input.gain.value = 1
  gain.gain.value = 0
  panner.pan.value = 0

  // The chain starts empty and is therefore a straight wire from the input to
  // the fader; the effects arrive with the first mix. Built here rather than on
  // the first effect added, so that adding one only ever writes into a chain
  // that is already in the signal path and never has to splice itself in.
  const effects = createEffectChain(context, input, gain, [])

  gain.connect(panner)
  panner.connect(analyser)
  analyser.connect(getMasterGain())

  const strip: ChannelStrip = {
    input,
    gain,
    panner,
    analyser,
    effects,
    voices: new Set(),
    onActiveChange
  }
  strips.set(channelId, strip)
  return strip
}

export function getStrip(channelId: string): ChannelStrip | undefined {
  return strips.get(channelId)
}

/** Ramp a channel's gain. This is what mute, solo and volume all resolve to. */
export function setStripGain(strip: ChannelStrip, value: number): void {
  const now = getAudioContext().currentTime
  strip.gain.gain.cancelScheduledValues(now)
  strip.gain.gain.setTargetAtTime(value, now, RAMP_SEC)
}

/** Ramp a channel's pan, -1 (hard left) to 1 (hard right). */
export function setStripPan(strip: ChannelStrip, value: number): void {
  const now = getAudioContext().currentTime
  strip.panner.pan.cancelScheduledValues(now)
  strip.panner.pan.setTargetAtTime(value, now, RAMP_SEC)
}

/**
 * Hand a channel its effect chain, in order.
 *
 * Like `setStripGain` and `setStripPan`, this describes the state the channel
 * should be in rather than asking for a change to it, and like them it is safe
 * to call with the value it already has: the chain works out for itself whether
 * anything about the list demands a rebuild, and writes the parameters into the
 * nodes it already has when it does not. That is what makes a knob drag — which
 * calls this once per frame — a parameter ramp rather than a storm of rebuilds.
 */
export function setStripEffects(strip: ChannelStrip, effects: Effect[]): void {
  strip.effects.apply(effects)
}

/**
 * One scratch buffer per strip, reused for every read.
 *
 * A meter asks for this sixty times a second per channel, and the answer it gets
 * is one number: allocating an array to throw away on each of those would be a
 * per-frame allocation for the whole life of a loop.
 */
const peakScratch = new WeakMap<ChannelStrip, Float32Array<ArrayBuffer>>()

/**
 * How loud a channel is right now, as the loudest sample in the last window.
 *
 * Peak rather than an average, because the peaks are what a meter is read for —
 * where a level is going to clip, and where a drum's attack actually landed. It
 * is a displacement, so it is never negative and can pass 1 on a channel that is
 * summing past full scale; a caller drawing it is the one that decides what to
 * do about that.
 *
 * The value already accounts for the channel's own volume, pan, mute and solo,
 * because it is read off the end of the strip. Muted, this returns zero — the
 * gain is what muted it.
 */
export function readStripPeak(strip: ChannelStrip): number {
  let data = peakScratch.get(strip)
  if (data === undefined) {
    data = new Float32Array(strip.analyser.fftSize)
    peakScratch.set(strip, data)
  }

  strip.analyser.getFloatTimeDomainData(data)

  let peak = 0
  for (let index = 0; index < data.length; index += 1) {
    const value = Math.abs(data[index])
    if (value > peak) peak = value
  }
  return peak
}

/** The master output every channel ends at. Built on first use. */
export function getMasterGain(): GainNode {
  if (!masterGain) {
    const context = getAudioContext()
    const node = context.createGain()
    // Unity until somebody asks for less: an untouched app is not attenuated.
    node.gain.value = 1
    node.connect(context.destination)
    masterGain = node
  }
  return masterGain
}

/**
 * Ramp the master output, 0 (silent) to 1 (unity).
 *
 * One ramp for the whole app rather than one per channel, so a drag of the
 * master knob is a single scheduled change — and so a channel that starts
 * sounding mid-drag arrives at the level the knob is at, not at the one it was
 * at when the drag began.
 */
export function setMasterGain(value: number): void {
  const now = getAudioContext().currentTime
  const gain = getMasterGain().gain
  gain.cancelScheduledValues(now)
  gain.setTargetAtTime(value, now, RAMP_SEC)
}

/**
 * Register a voice on a strip, so the channel indicator and `stopStrip` see it.
 *
 * `onFinished` is passed for the last voice of a sequence only: its `onended`
 * then reports the sequence's real ending, which saves the transport from
 * polling the clock to notice that playback is over.
 *
 * Exported because the synth's scheduler lives in its own module and needs
 * exactly this: a strip that knows a voice is sounding through it, whether that
 * voice is a sample or an oscillator is not the strip's business.
 */
export function trackVoice(
  strip: ChannelStrip,
  source: AudioScheduledSourceNode,
  onFinished?: () => void,
  tail: AudioNode[] = []
): void {
  const voice: Voice = { source, tail }
  strip.voices.add(voice)
  if (strip.voices.size === 1) {
    strip.onActiveChange(true)
  }

  source.onended = () => {
    disposeVoice(voice)
    strip.voices.delete(voice)
    if (strip.voices.size === 0) {
      strip.onActiveChange(false)
    }
    onFinished?.()
  }
}

/** Detach a voice's nodes. Safe to call on one that has already been cut. */
function disposeVoice(voice: Voice): void {
  voice.source.disconnect()
  for (const node of voice.tail) {
    node.disconnect()
  }
}

// Pitch shifting.
//
// SoundTouch is a time-domain shifter: it stretches the sample by 1/pitch and
// then resamples by pitch, so the two cancel out and the copy comes back the
// length it went in. That is the whole point — transposing a note must not touch
// how long it lasts.
//
// The shifting happens once, up front, rather than per voice at playback time.
// A real-time shifter would be a node in every voice's chain, and it would put a
// processing latency between `start(when)` and the first audible sample, which
// is exactly the thing the scheduler above does not have. Rendering the copy
// ahead of time keeps voices plain buffer sources, so notes still start on the
// sample the clock was told about.
//
// The cost is that rendering is synchronous and blocks the main thread, so the
// result is cached for as long as the sample it came from is alive: one render
// per (sample, pitch), not per note. Pitch 0 renders nothing at all, which is
// the case every step-sequencer trigger is.

/** Frames per pull. Also the ceiling on how much output one call can return. */
const SHIFT_CHUNK_FRAMES = 4096

/**
 * Frames of silence appended to a sample before it is shifted.
 *
 * The filter that drives SoundTouch only pumps its pipe once it can fill a whole
 * 16384-frame block, and it gives up for good the moment a source hands back
 * less than it asked for. A sample shorter than one block — every drum hit, most
 * one-shots — would therefore shift into nothing at all. Feeding silence past
 * the end keeps the source supplying until the shifter's window has carried the
 * sample's real tail out, and the window lags behind by about one block, so two
 * blocks of padding covers it. The padding is trimmed off the result afterwards.
 */
const SHIFT_PAD_FRAMES = 16384 * 2

/**
 * Shifted copies, keyed by sample first and pitch second.
 *
 * Weak on the sample because a sample's buffer is the thing that gets replaced
 * when a file is reloaded; its shifted copies have no meaning without it and
 * should not outlive it.
 */
const pitchShiftCache = new WeakMap<AudioBuffer, Map<number, AudioBuffer>>()

/**
 * An AudioBuffer seen as a stream of interleaved stereo frames, with silence
 * stuck on the end. This is what SoundTouch pulls from.
 *
 * Two things it does that the library's own buffer source does not. It pads,
 * because of the block size above. And it reads past the end as silence rather
 * than as whatever the underlying typed array has there — its `extract` is
 * always asked for more frames than the sample has left.
 */
class PaddedSampleSource {
  private readonly left: Float32Array
  private readonly right: Float32Array
  /** Length of the sample itself, in frames. Padding starts here. */
  private readonly frames: number
  /** Real audio and padding together: everything this source can supply. */
  private readonly total: number

  constructor(buffer: AudioBuffer) {
    this.frames = buffer.length
    this.total = this.frames + SHIFT_PAD_FRAMES
    this.left = buffer.getChannelData(0)
    // A mono sample reads from the same channel twice, which is what feeding the
    // shifter two identical channels means.
    this.right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : this.left
  }

  /**
   * Write up to `numFrames` frames from `position`, returning how many were
   * written, or 0 once the padding is used up.
   *
   * A short read is what tells the filter to stop, so this returns everything it
   * can rather than the whole request — the padding is the only reason the last
   * read is ever short.
   */
  extract(target: Float32Array, numFrames = 0, position = 0): number {
    const available = this.total - position
    if (numFrames <= 0 || available <= 0) return 0

    const count = Math.min(numFrames, available)
    const audible = Math.max(0, Math.min(count, this.frames - position))

    for (let i = 0; i < audible; i += 1) {
      target[i * 2] = this.left[position + i]
      target[i * 2 + 1] = this.right[position + i]
    }
    // Past the sample the padding is silence, and the caller's buffer is reused
    // between reads, so it has to be written rather than left alone.
    target.fill(0, audible * 2, count * 2)

    return count
  }
}

/**
 * The sample a note at `semitones` should sound: the buffer itself at 0, and
 * otherwise a re-pitched copy of it, rendered on first use and kept after.
 *
 * Always played at rate 1 — a caller that reaches for `playbackRate` instead
 * gets the pitch but loses the note's length with it.
 */
export function pitchShiftedBuffer(buffer: AudioBuffer, semitones: number): AudioBuffer {
  if (semitones === 0) return buffer

  let byPitch = pitchShiftCache.get(buffer)
  if (!byPitch) {
    byPitch = new Map()
    pitchShiftCache.set(buffer, byPitch)
  }

  const cached = byPitch.get(semitones)
  if (cached) return cached

  const shifted = renderPitchShift(buffer, semitones)
  byPitch.set(semitones, shifted)
  return shifted
}

/** Run a whole sample through SoundTouch once, at one pitch. */
function renderPitchShift(buffer: AudioBuffer, semitones: number): AudioBuffer {
  const context = getAudioContext()

  const soundtouch = new SoundTouch()
  soundtouch.pitchSemitones = semitones
  const filter = new SimpleFilter(new PaddedSampleSource(buffer), soundtouch)

  // Pull the shifted sample out in chunks. `extract` returns 0 once the source
  // is drained and the pipe has run dry, which is the real end condition; the
  // frame cap is only there so that a change in the library's behaviour cannot
  // spin this loop forever. The padding is what the source can still supply past
  // the sample, so a little over that is already past any honest result.
  const scratch = new Float32Array(SHIFT_CHUNK_FRAMES * 2)
  const chunks: Float32Array[] = []
  const maxFrames = buffer.length + SHIFT_PAD_FRAMES + buffer.sampleRate
  let frames = 0

  while (frames < maxFrames) {
    const extracted = filter.extract(scratch, SHIFT_CHUNK_FRAMES)
    if (extracted <= 0) break
    // A copy: the scratch buffer is reused by the next pull.
    chunks.push(scratch.slice(0, extracted * 2))
    frames += extracted
  }

  // A shift is length-preserving, so the sample's own length is where its signal
  // ends and the padding begins. Cutting there drops the padding and nothing
  // else — and makes the copy exactly as long as the sample it came from, so a
  // note at any pitch reaches the end of its sample at the same moment.
  const length = Math.min(frames, buffer.length)

  // No decoded sample is empty, so a length of 0 is a guard against the library
  // changing shape rather than a case that happens. Unpitched beats unplayable.
  if (length === 0) return buffer

  // The filter reads at most two channels and hands them back interleaved, so a
  // mono sample would come home twice as wide as it left. Keep what it had.
  const channels = Math.min(buffer.numberOfChannels, 2)
  const shifted = context.createBuffer(channels, length, buffer.sampleRate)

  for (let channel = 0; channel < channels; channel += 1) {
    const target = shifted.getChannelData(channel)
    let write = 0
    for (const chunk of chunks) {
      // De-interleave: the chunks are stereo, so this channel's frames sit every
      // other sample, starting at the channel's own index.
      for (let read = channel; read < chunk.length && write < length; read += 2) {
        target[write] = chunk[read]
        write += 1
      }
      if (write === length) break
    }
  }

  return shifted
}

/**
 * What a velocity does to a voice's gain.
 *
 * Linear against the MIDI range. Velocity is not a fader — the channel's own
 * volume, mute and solo stay on the strip's gain — so this only ever scales the
 * one voice it belongs to.
 */
export function gainForVelocity(velocity: number): number {
  return Math.min(Math.max(velocity, 0), 127) / 127
}

/**
 * Start a one-shot voice through a strip.
 *
 * Voices are independent, so a channel can overlap with itself — the same way
 * hitting a drum pad twice does. `pitch` is a semitone offset like a note's, so
 * a piano key can audition the note it stands for without a note existing yet.
 * Auditioning is pitched the same way a note is, so the key and the note it
 * would draw sound alike.
 *
 * A caller holding a whole instrument resolves the zone itself and passes that
 * zone's buffer with the shift left over — `voiceForPitch` gives both — rather
 * than a buffer for the engine to pitch. This one sounds what it is handed.
 */
export function triggerStrip(strip: ChannelStrip, buffer: AudioBuffer, pitch = 0): void {
  const context = getAudioContext()

  const source = context.createBufferSource()
  source.buffer = pitchShiftedBuffer(buffer, pitch)
  source.connect(strip.input)
  trackVoice(strip, source)

  source.start(context.currentTime)
}

/**
 * Schedule a whole note sequence on one strip.
 *
 * Cuts whatever the strip is already doing first, so the sequence starts from a
 * clean strip. A caller that is *extending* a sequence rather than replacing it —
 * the step sequencer reserving its next loop — wants `scheduleNoteSequence`
 * instead; stopping here would silence the pass that is still playing.
 */
export function playNoteSequence(
  strip: ChannelStrip,
  zones: SampleZone[],
  notes: Note[],
  startAtSec: number,
  onFinished: () => void
): void {
  stopStrip(strip)
  scheduleNoteSequence(strip, zones, notes, startAtSec, onFinished)
}

/**
 * A note as the song timeline hands it over: the note, plus the volume curve of
 * the clip it came from.
 *
 * The song flattens its clips into notes before it gets here, and a clip may
 * carry a curve — so the curve has to travel with the notes it shapes, because
 * by the time the scheduler sees a note, which clip it came from is gone. Not
 * that it would help: two clips of one pattern on the same channel are two sets
 * of the same notes, and only the curve each note is carrying tells them apart.
 *
 * Both fields are optional, so a plain `Note` — the step loop's, the piano
 * roll's — is still one of these. A note without a curve schedules exactly what
 * it always did, down to the node count.
 */
export type SongNote = Note & {
  /** The clip's curve, in seconds from the clip's start. Sorted; see `normalizeCurve`. */
  curve?: CurvePoint[]
  /** Where inside that clip this note starts, in seconds. */
  curveOffsetSec?: number
}

/**
 * Write a curve into a gain parameter, as the piece of it that falls over one note.
 *
 * The curve is written against the clip, and every note of that clip only owns
 * its own stretch of it — so this cuts the curve down to the note's span and
 * shifts its times onto the audio clock.
 *
 * The note opens on the value the curve has *at its start*, interpolated, not on
 * the value of the next node: a note that begins in the middle of a rise starts
 * part way up it, which is the whole point of automating a clip rather than
 * each note.
 *
 * `points` must be sorted by time — `normalizeCurve` is what guarantees it, and
 * the ramps below are written in that order.
 */
export function scheduleGainCurve(
  param: AudioParam,
  points: CurvePoint[],
  offsetSec: number,
  atSec: number,
  lengthSec: number
): void {
  const endSec = offsetSec + lengthSec
  param.setValueAtTime(curveValueAt(points, offsetSec), atSec)

  for (const point of points) {
    if (point.time <= offsetSec) continue
    if (point.time >= endSec) break
    param.linearRampToValueAtTime(point.value, atSec + (point.time - offsetSec))
  }
}

/**
 * Schedule a whole note sequence on one strip, *without* cutting what the strip
 * already has.
 *
 * Every voice is handed to the audio clock up front with `start(when)`/`stop(when)`,
 * so nothing here needs a timer: the browser starts and stops each sample at the
 * exact time asked for. Each note is cut at its own end and nothing else, so
 * notes that overlap sound together — which is what makes a chord a chord. A
 * caller that wants one voice at a time has to ask for it by handing over notes
 * that do not overlap, the way the step sequencer does.
 *
 * What is audible is therefore the note's *sounding* length — the length it was
 * drawn at plus the tail it carries (`Note.extend`), which is what `soundingSec`
 * adds up. A short note chops the sample, a long one lets it ring, and extending
 * one is how a note that chops too soon is given the room to decay instead: the
 * tail is the same note held open, not a second voice. Either way the chop is
 * faded rather than abrupt, so a note being cut short does not arrive as a click.
 * Pitch is a semitone offset, sounded by a re-pitched copy of the recording the
 * note lands on rather than by a playback rate, so it cannot affect that length;
 * velocity scales that voice's own gain, and the two fades are laid over that
 * scale rather than folded into it.
 *
 * The release is only applied where there is a waveform to release. A note that
 * outlasts its recording is not cutting anything — the sample reaches its own end
 * and stops — so fading there would only be shaping a decay that is already over.
 * The body of the note checks the two ends against each other and skips the
 * release when there is nothing to skip. Extending a note is the ordinary way to
 * reach that case: long enough, and the note is let go of rather than cut.
 *
 * `zones` is the whole instrument, not one buffer, because which recording a note
 * plays depends on the note: see `voiceForPitch`. A single-file sample is the
 * one-zone case, and every note of it shifts by its own pitch — exactly what a
 * single `buffer` used to do.
 *
 * A note that carries a clip's volume curve gets one more node in its chain and
 * one more set of ramps on it — see `SongNote`. Everything else about it is
 * unchanged, and a note without a curve is scheduled exactly as it always was.
 *
 * `startAtSec` is an absolute `AudioContext.currentTime` value, so the caller can
 * derive a playhead from the very same number. `onFinished` is optional because
 * only a sequence with an end has anything to report: a loop calls this again
 * before the previous pass is over.
 */
export function scheduleNoteSequence(
  strip: ChannelStrip,
  zones: SampleZone[],
  notes: SongNote[],
  startAtSec: number,
  onFinished?: () => void
): void {
  const context = getAudioContext()
  const ordered = [...notes].sort((a, b) => a.startSec - b.startSec)

  ordered.forEach((note, index) => {
    // A zero-length note would be scheduled to stop the moment it starts.
    if (note.lengthSec <= 0) return

    const noteStart = startAtSec + note.startSec
    // How long this note is heard for: what it was drawn as, plus its tail. The
    // guard above still reads `lengthSec` alone — a tail is not a length, so a
    // note drawn with no length is a mistake however far it is extended, while a
    // note drawn short and extended to ring is the ordinary case this is for.
    const soundSec = soundingSec(note)
    const noteEnd = noteStart + soundSec

    // Which recording this note plays is the note's own business, not the
    // channel's: a multisampled instrument covers the keyboard in zones, and two
    // notes of the same channel can easily come from two different recordings.
    const voice = voiceForPitch(zones, note.pitch)

    const source = context.createBufferSource()
    const rendered = pitchShiftedBuffer(voice.buffer, voice.shift)
    source.buffer = rendered

    // Velocity belongs to the note, so it needs a gain of its own: the strip's
    // gain is the channel's, and volume, mute and solo all write to that.
    const velocityGain = context.createGain()
    const level = gainForVelocity(note.velocity)
    const gain = velocityGain.gain

    // Both fades are bounded by half of what is heard, so that a note shorter
    // than the two of them together still opens and closes instead of having one
    // run over the other — which would leave it silent, or ending on a step after
    // all. Half of the *sounding* length, tail included, so that extending a
    // clipped note lengthens it rather than lengthening one of its two fades.
    const fadeInSec = Math.min(VOICE_FADE_IN_SEC, soundSec / 2)
    const fadeOutSec = Math.min(VOICE_FADE_OUT_SEC, soundSec / 2)

    // Whether this note is what ends the sound, or the sample is. Measured
    // against the buffer the note actually plays — a re-pitched copy is the same
    // length as its sample, but only by construction, and this is the copy that
    // is about to be heard.
    const cutsSample = noteEnd < noteStart + rendered.duration

    gain.setValueAtTime(0, noteStart)
    gain.linearRampToValueAtTime(level, noteStart + fadeInSec)
    if (cutsSample) {
      // Held flat up to the release, so the fade is the release and not a slope
      // running from the attack — a quiet note would otherwise be nothing but
      // fade on a long one.
      gain.setValueAtTime(level, noteEnd - fadeOutSec)
      gain.linearRampToValueAtTime(0, noteEnd)
    }

    // The clip's own volume curve, if this note came from a clip that has one.
    // A node of its own rather than another set of ramps on the one above: the
    // fades there are written against the note's velocity and would have to be
    // re-derived for every curve shape, while two gains in series simply
    // multiply — which is also what a note's velocity and its clip's automation
    // honestly are.
    const curve = note.curve
    const curveOffsetSec = note.curveOffsetSec
    let automation: GainNode | null = null
    if (curve !== undefined && curve.length > 0 && curveOffsetSec !== undefined) {
      automation = context.createGain()
      // Written over the note's own length rather than over what it sounds for: a
      // curve belongs to the clip, and where the clip ends is where its shape
      // ends. A tail runs on past that, holding whatever value the curve was left
      // at — and the fade below still closes it, so a tail is never a note that
      // forgot to stop.
      scheduleGainCurve(automation.gain, curve, curveOffsetSec, noteStart, note.lengthSec)
    }

    source.connect(velocityGain)
    if (automation === null) {
      velocityGain.connect(strip.input)
    } else {
      velocityGain.connect(automation)
      automation.connect(strip.input)
    }

    // Only the last note can report the end: notes are ordered, so the last one
    // to *start* is also the last to fall silent.
    trackVoice(strip, source, index === ordered.length - 1 ? onFinished : undefined, [
      velocityGain,
      ...(automation === null ? [] : [automation])
    ])

    source.start(noteStart)
    source.stop(noteEnd)
  })
}

/**
 * One channel's notes, ready to be scheduled.
 *
 * The notes come with a way to play them rather than with an instrument, because
 * there are two kinds of instrument now: a sampler hands over the recordings a
 * note may land on, and a synth hands over nothing but its parameters. Which one
 * a channel is, is the channel's business — this is the seam that keeps it
 * there, so the song can be run without knowing what is under it.
 *
 * `play` is expected to cut the strip first, as `playNoteSequence` does: song
 * playback is replacing whatever was sounding, not adding to it.
 */
export type ScheduledChannel = {
  strip: ChannelStrip
  /** Hand these notes to the audio clock on this channel's strip. */
  play: (notes: SongNote[], atSec: number, onFinished: () => void) => void
  /** `SongNote`s, because they come off the song timeline — see that type. */
  notes: SongNote[]
}

/**
 * Schedule a whole song: every channel's own note timeline, all at once.
 *
 * Song mode flattens the arrangement into one timeline per channel before it
 * gets here, so this is only "run several channels together" — each still plays
 * through its own scheduler, and each channel can therefore sound a chord.
 *
 * `onFinished` fires once, when the last channel falls silent, which is what
 * lets the transport stop itself without watching the clock.
 */
export function playArrangement(
  channels: ScheduledChannel[],
  startAtSec: number,
  onFinished: () => void
): void {
  // A channel with nothing to play would never report back.
  const audible = channels.filter((channel) => channel.notes.length > 0)
  if (audible.length === 0) {
    onFinished()
    return
  }

  let remaining = audible.length
  const handleChannelFinished = (): void => {
    remaining -= 1
    if (remaining === 0) {
      onFinished()
    }
  }

  for (const channel of audible) {
    channel.play(channel.notes, startAtSec, handleChannelFinished)
  }
}

/** Cut every voice on one channel, immediately. */
export function stopStrip(strip: ChannelStrip): void {
  for (const voice of strip.voices) {
    // Detach first: this is a deliberate cut, not the sample reaching its end.
    voice.source.onended = null
    try {
      // A voice that was only reserved stops before it ever sounds.
      voice.source.stop()
    } catch {
      // Already finished; nothing to cut.
    }
    disposeVoice(voice)
  }
  strip.voices.clear()
  strip.onActiveChange(false)
}

/** Cut every voice on every channel. */
export function stopAllStrips(): void {
  for (const strip of strips.values()) {
    stopStrip(strip)
  }
}

/**
 * Take one channel's strip apart: cut its voices, detach its nodes, forget it.
 *
 * Not the same thing as `stopStrip`, which only cuts the voices and leaves the
 * strip ready to play again. This is for a channel that is going away — loading
 * a project replaces the whole rack, and a strip left behind would stay wired to
 * the destination for the rest of the session.
 */
export function releaseStrip(channelId: string): void {
  const strip = strips.get(channelId)
  if (!strip) return
  stopStrip(strip)
  // Releases the chain's own nodes along with the input it was fed from, so a
  // channel that goes away takes its effects with it rather than leaving a
  // convolver wired to the destination for the rest of the session.
  strip.effects.dispose()
  strip.gain.disconnect()
  strip.panner.disconnect()
  strips.delete(channelId)
}

/** Take every strip apart. What loading a project and starting a new one both need. */
export function releaseAllStrips(): void {
  // Snapshot the keys: `releaseStrip` deletes from the map as it goes.
  for (const channelId of [...strips.keys()]) {
    releaseStrip(channelId)
  }
}
