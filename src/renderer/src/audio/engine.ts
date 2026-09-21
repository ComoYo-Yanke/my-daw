// Audio engine — the single owner of the AudioContext and of every audio node.
//
// Rules this module exists to enforce (see CLAUDE.md):
// - exactly one AudioContext, created lazily on the first user gesture
// - every time value is seconds, read from AudioContext.currentTime
// - audio is scheduled on the audio clock, never with setInterval/setTimeout
//
// Graph, per channel:
//
//   AudioBufferSourceNode -> GainNode -> GainNode -> StereoPannerNode -> destination
//        (per voice)      (per voice)   (per channel, persistent)
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
// a copy of the sample re-pitched ahead of time, of its original length. The
// note's own `lengthSec` is then the only thing that decides how long it lasts.
//
// No React and no store access here: this is plain Web Audio.

import { SimpleFilter, SoundTouch } from 'soundtouchjs'

import type { Note } from '../types/note'

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
  source: AudioBufferSourceNode
  /** Nodes this voice owns alone, disconnected when it ends or is cut. */
  tail: AudioNode[]
}

/**
 * A channel's mixer strip: the persistent gain and panner for one channel, plus
 * the voices currently sounding through it.
 */
export type ChannelStrip = {
  gain: GainNode
  panner: StereoPannerNode
  voices: Set<Voice>
  /** Called on the silent <-> sounding edges, so the UI can light an indicator. */
  onActiveChange: (active: boolean) => void
}

const strips = new Map<string, ChannelStrip>()

/**
 * Time constant for parameter changes, in seconds. Small enough to feel
 * instant, large enough that jumps in gain or pan do not click.
 */
const RAMP_SEC = 0.01

/** Build and connect a channel strip. Gain starts silent until the mix is applied. */
export function createStrip(
  channelId: string,
  onActiveChange: (active: boolean) => void
): ChannelStrip {
  const context = getAudioContext()

  const gain = context.createGain()
  const panner = context.createStereoPanner()
  gain.gain.value = 0
  panner.pan.value = 0
  gain.connect(panner)
  panner.connect(context.destination)

  const strip: ChannelStrip = { gain, panner, voices: new Set(), onActiveChange }
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
 * Register a voice on a strip, so the channel indicator and `stopStrip` see it.
 *
 * `onFinished` is passed for the last voice of a sequence only: its `onended`
 * then reports the sequence's real ending, which saves the transport from
 * polling the clock to notice that playback is over.
 */
function trackVoice(
  strip: ChannelStrip,
  source: AudioBufferSourceNode,
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
 */
export function triggerStrip(strip: ChannelStrip, buffer: AudioBuffer, pitch = 0): void {
  const context = getAudioContext()

  const source = context.createBufferSource()
  source.buffer = pitchShiftedBuffer(buffer, pitch)
  source.connect(strip.gain)
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
  buffer: AudioBuffer,
  notes: Note[],
  startAtSec: number,
  onFinished: () => void
): void {
  stopStrip(strip)
  scheduleNoteSequence(strip, buffer, notes, startAtSec, onFinished)
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
 * Note length is therefore audible: a short note chops the sample, a long one
 * lets it ring. Pitch is a semitone offset, sounded by a re-pitched copy of the
 * sample rather than by a playback rate, so it cannot affect that length;
 * velocity scales that voice's own gain.
 *
 * `startAtSec` is an absolute `AudioContext.currentTime` value, so the caller can
 * derive a playhead from the very same number. `onFinished` is optional because
 * only a sequence with an end has anything to report: a loop calls this again
 * before the previous pass is over.
 */
export function scheduleNoteSequence(
  strip: ChannelStrip,
  buffer: AudioBuffer,
  notes: Note[],
  startAtSec: number,
  onFinished?: () => void
): void {
  const context = getAudioContext()
  const ordered = [...notes].sort((a, b) => a.startSec - b.startSec)

  ordered.forEach((note, index) => {
    // A zero-length note would be scheduled to stop the moment it starts.
    if (note.lengthSec <= 0) return

    const noteStart = startAtSec + note.startSec

    const source = context.createBufferSource()
    source.buffer = pitchShiftedBuffer(buffer, note.pitch)

    // Velocity belongs to the note, so it needs a gain of its own: the strip's
    // gain is the channel's, and volume, mute and solo all write to that.
    const velocityGain = context.createGain()
    velocityGain.gain.value = gainForVelocity(note.velocity)
    source.connect(velocityGain)
    velocityGain.connect(strip.gain)

    // Only the last note can report the end: notes are ordered, so the last one
    // to *start* is also the last to fall silent.
    trackVoice(strip, source, index === ordered.length - 1 ? onFinished : undefined, [velocityGain])

    source.start(noteStart)
    source.stop(noteStart + note.lengthSec)
  })
}

/** One channel's notes, ready to be scheduled. */
export type ScheduledChannel = {
  strip: ChannelStrip
  buffer: AudioBuffer
  notes: Note[]
}

/**
 * Schedule a whole song: every channel's own note timeline, all at once.
 *
 * Song mode flattens the arrangement into one timeline per channel before it
 * gets here, so this is only "run several channels together" — each still goes
 * through `playNoteSequence`, and each channel can therefore sound a chord.
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
    playNoteSequence(
      channel.strip,
      channel.buffer,
      channel.notes,
      startAtSec,
      handleChannelFinished
    )
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
