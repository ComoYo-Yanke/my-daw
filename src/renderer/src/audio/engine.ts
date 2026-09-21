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
// No React and no store access here: this is plain Web Audio.

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

/** The playback rate that sounds a note's semitone offset: one octave, one octave. */
export function rateForPitch(pitch: number): number {
  return 2 ** (pitch / 12)
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
 */
export function triggerStrip(strip: ChannelStrip, buffer: AudioBuffer, pitch = 0): void {
  const context = getAudioContext()

  const source = context.createBufferSource()
  source.buffer = buffer
  source.playbackRate.value = rateForPitch(pitch)
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
 * lets it ring. Pitch is a semitone offset applied as a playback rate, and
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
    source.buffer = buffer
    source.playbackRate.value = rateForPitch(note.pitch)

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
