// Offline rendering and WAV encoding for 导出音频.
//
// The live engine's graph is rebuilt here for a different context. An
// OfflineAudioContext renders as fast as the machine can rather than in real
// time, which is the point of it: a three-minute song comes back in seconds.
//
// Graph per channel, mirroring `engine.ts` exactly:
//
//   AudioBufferSourceNode -> GainNode -> [GainNode] -> GainNode -> [effects] -> GainNode
//        (per note)        (velocity)   (curve)     (strip input)             (channel)
//                                                       -> StereoPannerNode -> master
//
// A synth channel is the same picture with a different voice in it — its own
// whole chain comes from `buildSynthVoice`, the function the live engine calls,
// so a synth export cannot drift from a synth playback:
//
//   Oscillator(s) -> BiquadFilter -> GainNode(ADSR) -> [GainNode] -> strip -> master
//                                                     (curve)
//
// The effects are the live ones, from `createEffectChain` — handed an
// OfflineAudioContext rather than the live AudioContext. That context parameter
// is the whole of how a reverb can be exported without a second implementation of
// it existing to keep in step, and it is why the impulse response in the file is
// generated from the same settings by the same code as the one that was heard.
// There is no knob to turn mid-render, so each chain is built from the settings
// the channel holds at that moment and is never written to again.
//
// Everything else on a strip is a value rather than a shape, and is copied across
// holding what it holds right now — which is what makes the export sound like what
// was on screen. A clip's volume curve is the one thing that is not a value but a
// shape, and it is copied across as a shape: the same `scheduleGainCurve` the
// live engine calls, so a fade written on the timeline fades the same way in the
// file. Offline, nothing is heard until the render runs, so the ramps are written
// against the song's own clock rather than the context's.
//
// Nothing in here reads the store: the caller flattens the song into
// `ExportVoice`s first. That keeps the render the same code whatever the
// timeline was made of, and keeps the store out of the DSP.

import { Mp3Encoder } from '@breezystack/lamejs'

import { createEffectChain } from './effects'
import { gainForVelocity, pitchShiftedBuffer, scheduleGainCurve, type SongNote } from './engine'
import { buildSynthVoice } from './synth'
import type { Effect } from '../types/effect'
import { soundingSec } from '../types/note'
import { voiceForPitch, type SampleZone } from '../types/sample'
import type { SynthParams } from '../types/synth'

/** What an export is written as. */
export type ExportFormat = 'wav' | 'mp3'

/** How many bytes one sample takes. WAV only; MP3 is lossy and has no such knob. */
export type ExportBitDepth = 16 | 24

/** Bit rates offered for MP3, in kbps. */
export const MP3_BIT_RATES = [128, 192, 256, 320] as const

/** What the render needs. */
export type RenderSettings = {
  /** 44100 or 48000. */
  sampleRate: number
  /** Master output trim, in dB. 0 is unity. */
  gainDb: number
  /** Scale the result so its loudest peak sits just under full scale. */
  normalize: boolean
}

/** Everything an export needs: the render, and then how to write it out. */
export type ExportSettings = RenderSettings & {
  format: ExportFormat
  bitDepth: ExportBitDepth
  /** MP3 only. */
  mp3BitRate: number
  /** Silence left after the last bar, in seconds. */
  tailSec: number
}

/**
 * One channel's part of the mix.
 *
 * The invariants are in the type as a union, because the two kinds of channel do
 * not render the same way at all: a sampler picks a recording per note and shifts
 * it, and a synth builds an oscillator chain per note. `kind` is what says which
 * of those the render is looking at.
 */
export type ExportVoice = {
  /** The channel's own gain, with mute and solo already folded in. */
  gain: number
  /** -1 to 1. */
  pan: number
  /**
   * The channel's effect chain, in order, bypassed effects included.
   *
   * The chain itself is what decides what a bypassed effect means, so an export
   * is not handed a filtered list: it hands over what the channel holds and gets
   * the same answer playback gave.
   */
  effects: Effect[]
  /** Notes in seconds, from the start of the song, each carrying its clip's curve. */
  notes: SongNote[]
} & (
  | {
      kind: 'sampler'
      /** The channel's whole instrument, zones and all — see `voiceForPitch`. */
      zones: SampleZone[]
    }
  | {
      kind: 'synth'
      /** The whole instrument, in this case: ten numbers and no recording. */
      params: SynthParams
    }
)

export type ExportStage = 'prepare' | 'render' | 'encode'

export type ExportProgress = {
  stage: ExportStage
  /** 0 to 1 within the stage. */
  ratio: number
}

/** How loud a dB figure is as a linear gain. */
export function dbToGain(db: number): number {
  return Math.pow(10, db / 20)
}

/**
 * Hand the main thread back.
 *
 * A message round-trip is a macrotask, which is what lets the browser paint the
 * progress bar between chunks. A resolved promise would not do — microtasks all
 * drain before the next paint, so the bar would sit still and then jump. `rAF`
 * is wrong here for the opposite reason: it stops firing while the window is in
 * the background, which would stall an export the moment the user looked away.
 */
function yieldToUi(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel()
    channel.port1.onmessage = () => {
      channel.port1.close()
      resolve()
    }
    channel.port2.postMessage(null)
  })
}

/** Roughly how much audio to render between progress reports, in seconds. */
const PROGRESS_EVERY_SEC = 2

/** A ceiling on those reports, so a long song does not pay for a hundred hops. */
const MAX_PROGRESS_STEPS = 60

/**
 * Render the whole song into one buffer.
 *
 * `durationSec` is what the song measures end to end, tail included; the result
 * is exactly that long, sample-aligned, which is what makes the exported file's
 * duration match the timeline's.
 *
 * Voices are pitched before the render starts rather than during it. Shifting is
 * synchronous and blocks whatever thread it runs on, and doing it inside the
 * graph would put the whole cost in one lump the progress bar could not see past.
 * Done up front, each shifted copy is cached, so the render itself is pure
 * scheduling and finishes in one go.
 */
export async function renderMix(
  voices: ExportVoice[],
  durationSec: number,
  settings: RenderSettings,
  onProgress: (progress: ExportProgress) => void
): Promise<AudioBuffer> {
  const frames = Math.max(1, Math.ceil(durationSec * settings.sampleRate))
  const offline = new OfflineAudioContext(2, frames, settings.sampleRate)

  const master = offline.createGain()
  master.gain.value = dbToGain(settings.gainDb)
  master.connect(offline.destination)

  await warmPitchCache(voices, onProgress)

  for (const voice of voices) {
    const notes = voice.notes.filter((note) => note.lengthSec > 0)
    if (notes.length === 0) continue

    // The strip outlives the notes the way it does live: an input, a gain and a
    // panner for the channel, with every voice of it hanging off the same set.
    const stripInput = offline.createGain()
    stripInput.gain.value = 1
    const stripGain = offline.createGain()
    stripGain.gain.value = voice.gain
    const panner = offline.createStereoPanner()
    panner.pan.value = Math.min(Math.max(voice.pan, -1), 1)

    // Between the input and the gain, which is where the live strip puts it — so
    // the channel's volume is applied after its effects in the file as well, and
    // a quiet channel is a quiet reverb tail rather than a loud one turned down
    // afterwards.
    createEffectChain(offline, stripInput, stripGain, voice.effects)

    stripGain.connect(panner)
    panner.connect(master)

    for (const note of notes) {
      // Both kinds of voice hang off the same node, which is where the clip's
      // curve sits — see `noteTarget`.
      const target = noteTarget(offline, stripInput, note)

      if (voice.kind === 'synth') {
        // The synth's own graph, note for note the one the live engine builds —
        // which is why the same function is called from both. Nothing extra goes
        // on top: velocity is already the height of the envelope, and the curve
        // above is the only thing that multiplies it.
        buildSynthVoice(offline, voice.params, note, note.startSec).output.connect(target)
        continue
      }

      // Same pick the live engine makes, so an exported note lands on the same
      // recording it played back on.
      const picked = voiceForPitch(voice.zones, note.pitch)

      const source = offline.createBufferSource()
      source.buffer = pitchShiftedBuffer(picked.buffer, picked.shift)

      const velocityGain = offline.createGain()
      velocityGain.gain.value = gainForVelocity(note.velocity)
      source.connect(velocityGain)
      velocityGain.connect(target)

      // Stopped where the live engine stops it, tail included: a file that cut
      // every note back to the length it was drawn at would be missing exactly the
      // decays the tails were added to hear.
      source.start(note.startSec)
      source.stop(note.startSec + soundingSec(note))
    }
  }

  await scheduleProgressReports(offline, durationSec, onProgress)

  const rendered = await offline.startRendering()
  onProgress({ stage: 'render', ratio: 1 })

  if (settings.normalize) {
    await normalizePeak(rendered, onProgress)
  }
  return rendered
}

/**
 * The node one note's voice hangs off: what shapes it, rather than where it goes.
 *
 * A clip may carry a volume curve. Where it does, that curve rides along exactly
 * as it does live — the same `scheduleGainCurve`, the same ramps — so a fade on
 * the timeline is a fade in the file, over the note's own length as live: the
 * curve belongs to the clip, and a tail runs on past where its shape ends. Where
 * there is none, the note's voice hangs straight off the strip's input — ahead of
 * the effects, as live, so a curve shapes what is fed to the reverb rather than
 * what comes back from it.
 *
 * Reading it as a node rather than as a branch is what lets the sampler and the
 * synth below be written once each instead of once each per automation case.
 */
function noteTarget(offline: OfflineAudioContext, stripInput: GainNode, note: SongNote): AudioNode {
  const curve = note.curve
  const curveOffsetSec = note.curveOffsetSec
  if (curve === undefined || curve.length === 0 || curveOffsetSec === undefined) return stripInput

  const automation = offline.createGain()
  scheduleGainCurve(automation.gain, curve, curveOffsetSec, note.startSec, note.lengthSec)
  automation.connect(stripInput)
  return automation
}

/**
 * Render every distinct (recording, shift) pair the song needs, in chunks.
 *
 * A shift of 0 is skipped: that is the recording itself, and `pitchShiftedBuffer`
 * hands it straight back without rendering anything.
 *
 * The pair is what gets deduplicated rather than the note's pitch, because a
 * note's pitch is only half of what decides which copy it needs — the zone it
 * lands on is the other half. Notes an octave apart can want the same recording
 * at the same shift, and notes a semitone apart can want two different ones.
 *
 * Synth voices have nothing to warm: their pitch is an oscillator frequency, and
 * a frequency needs no rendering before it can be played.
 */
async function warmPitchCache(
  voices: ExportVoice[],
  onProgress: (progress: ExportProgress) => void
): Promise<void> {
  const seen = new Map<AudioBuffer, Set<number>>()
  const pending: { buffer: AudioBuffer; shift: number }[] = []

  for (const voice of voices) {
    if (voice.kind === 'synth') continue
    for (const note of voice.notes) {
      if (note.lengthSec <= 0) continue

      const picked = voiceForPitch(voice.zones, note.pitch)
      if (picked.shift === 0) continue

      let shifts = seen.get(picked.buffer)
      if (!shifts) {
        shifts = new Set()
        seen.set(picked.buffer, shifts)
      }
      if (shifts.has(picked.shift)) continue
      shifts.add(picked.shift)
      pending.push({ buffer: picked.buffer, shift: picked.shift })
    }
  }

  if (pending.length === 0) {
    onProgress({ stage: 'prepare', ratio: 1 })
    return
  }

  pending.forEach((item, index) => {
    // The return value is not wanted; the point is the cache it leaves behind.
    pitchShiftedBuffer(item.buffer, item.shift)
    if (index % 8 === 7) onProgress({ stage: 'prepare', ratio: (index + 1) / pending.length })
  })
  onProgress({ stage: 'prepare', ratio: 1 })

  // Nothing above yielded, so the bar has not moved yet. One hop here is enough
  // for it to catch up before the render — which is the long, opaque part.
  await yieldToUi()
}

/**
 * Ask the offline context to stop every so often on its way through the song.
 *
 * There is no render-progress event, so this is how the bar gets to be honest
 * rather than a guess: each suspension resolves when the render actually reaches
 * that point in the audio, and the render waits there until it is resumed.
 *
 * Failures are swallowed. A suspension that lands past the end — or a render
 * that finished first — rejects, and that is a progress bar losing a tick, not
 * an export that failed.
 */
async function scheduleProgressReports(
  offline: OfflineAudioContext,
  durationSec: number,
  onProgress: (progress: ExportProgress) => void
): Promise<void> {
  const steps = Math.min(
    MAX_PROGRESS_STEPS,
    Math.max(1, Math.round(durationSec / PROGRESS_EVERY_SEC))
  )
  if (steps <= 1) return

  for (let step = 1; step < steps; step += 1) {
    const atSec = (durationSec * step) / steps
    if (atSec <= 0 || atSec >= durationSec) continue
    void offline
      .suspend(atSec)
      .then(() => {
        onProgress({ stage: 'render', ratio: step / steps })
        void offline.resume()
      })
      .catch(() => undefined)
  }
}

/** Peak level the normalize option aims for: a decibel below full scale. */
const NORMALIZE_TARGET_DB = -1

/**
 * Scale the render so its loudest sample sits at the target.
 *
 * Applied to the buffer rather than as another gain node, because it can only be
 * known once everything has been summed — and because it has to scale what is
 * already there rather than ride a fader over it.
 */
async function normalizePeak(
  buffer: AudioBuffer,
  onProgress: (progress: ExportProgress) => void
): Promise<void> {
  const data: Float32Array[] = []
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    data.push(buffer.getChannelData(channel))
  }

  let peak = 0
  for (const samples of data) {
    for (let i = 0; i < samples.length; i += 1) {
      const value = Math.abs(samples[i])
      if (value > peak) peak = value
    }
    onProgress({ stage: 'encode', ratio: 0 })
    await yieldToUi()
  }

  // Silence has no peak to move, and scaling it would only amplify the noise
  // floor of a render that has nothing in it.
  if (peak === 0) return

  const scale = dbToGain(NORMALIZE_TARGET_DB) / peak
  for (const samples of data) {
    for (let i = 0; i < samples.length; i += 1) {
      samples[i] *= scale
    }
    await yieldToUi()
  }
}

/** Frames encoded between yields. About 1.5 seconds of stereo at 44.1k. */
const ENCODE_CHUNK_FRAMES = 1 << 16

/**
 * Encode a rendered buffer as a PCM WAV file.
 *
 * Standard 44-byte RIFF header over interleaved little-endian samples, which is
 * what every system player reads. 24-bit is written as three bytes by hand
 * because `DataView` has no 24-bit setter; the arithmetic is the same two's
 * complement the 16-bit path gets from `setInt16`.
 */
export async function encodeWav(
  buffer: AudioBuffer,
  bitDepth: ExportBitDepth,
  onProgress: (progress: ExportProgress) => void
): Promise<Uint8Array> {
  const channels = Math.min(2, buffer.numberOfChannels)
  const frames = buffer.length
  const bytesPerSample = bitDepth / 8
  const blockAlign = channels * bytesPerSample
  const dataBytes = frames * blockAlign

  const out = new Uint8Array(44 + dataBytes)
  const view = new DataView(out.buffer)

  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeAscii(view, 8, 'WAVE')
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true) // Size of the fmt chunk that follows.
  view.setUint16(20, 1, true) // Format 1: uncompressed PCM.
  view.setUint16(22, channels, true)
  view.setUint32(24, buffer.sampleRate, true)
  view.setUint32(28, buffer.sampleRate * blockAlign, true) // Byte rate.
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bitDepth, true)
  writeAscii(view, 36, 'data')
  view.setUint32(40, dataBytes, true)

  const data: Float32Array[] = []
  for (let channel = 0; channel < channels; channel += 1) {
    data.push(buffer.getChannelData(channel))
  }

  let offset = 44
  for (let start = 0; start < frames; start += ENCODE_CHUNK_FRAMES) {
    const end = Math.min(frames, start + ENCODE_CHUNK_FRAMES)

    for (let frame = start; frame < end; frame += 1) {
      for (let channel = 0; channel < channels; channel += 1) {
        // Clamped rather than wrapped: a render that overshot full scale is a
        // loud file, and 16-bit wrapping would turn that into a burst of noise.
        const sample = clampSample(data[channel][frame])
        if (bitDepth === 16) {
          view.setInt16(offset, Math.round(sample * 32767), true)
          offset += 2
        } else {
          const value = Math.round(sample * 8388607)
          out[offset] = value & 0xff
          out[offset + 1] = (value >> 8) & 0xff
          out[offset + 2] = (value >> 16) & 0xff
          offset += 3
        }
      }
    }

    onProgress({ stage: 'encode', ratio: end / frames })
    await yieldToUi()
  }

  return out
}

/**
 * MPEG frames encoded between yields. One frame is 1152 samples, and twenty of
 * them is about half a second of audio — long enough that the per-yield cost
 * does not show up, short enough that the window still answers the mouse.
 */
const MP3_CHUNK_FRAMES = 1152 * 20

/**
 * Encode a rendered buffer as an MP3.
 *
 * LAME works a frame at a time and holds whatever does not fill one, so the
 * chunks handed in here do not have to line up with anything — the leftover
 * carries over and `flush` at the end writes out what is still held.
 *
 * Encoding is a C-style loop over the whole song and blocks the thread it runs
 * on, which is why it is chunked and yielded like the WAV path: a three-minute
 * song is tens of millions of samples and would otherwise freeze the window for
 * as long as it took.
 */
export async function encodeMp3(
  buffer: AudioBuffer,
  bitRate: number,
  onProgress: (progress: ExportProgress) => void
): Promise<Uint8Array> {
  const channels = Math.min(2, buffer.numberOfChannels)
  const encoder = new Mp3Encoder(channels, buffer.sampleRate, bitRate)

  const left = buffer.getChannelData(0)
  const right = channels > 1 ? buffer.getChannelData(1) : left

  const chunks: Uint8Array[] = []
  let total = 0

  const keep = (encoded: Uint8Array): void => {
    if (encoded.length === 0) return
    // Copied rather than kept by reference: the encoder hands back a view into a
    // buffer it is free to reuse, and a chunk held that way would be overwritten
    // by the next call before it was ever concatenated.
    chunks.push(encoded.slice())
    total += encoded.length
  }

  for (let start = 0; start < buffer.length; start += MP3_CHUNK_FRAMES) {
    const end = Math.min(buffer.length, start + MP3_CHUNK_FRAMES)
    const leftChunk = toInt16(left, start, end)
    keep(
      channels > 1
        ? encoder.encodeBuffer(leftChunk, toInt16(right, start, end))
        : encoder.encodeBuffer(leftChunk)
    )

    onProgress({ stage: 'encode', ratio: end / buffer.length })
    await yieldToUi()
  }

  keep(encoder.flush())

  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

/** One slice of a rendered channel as the 16-bit samples the encoder wants. */
function toInt16(source: Float32Array, start: number, end: number): Int16Array {
  const out = new Int16Array(end - start)
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Math.round(clampSample(source[start + i]) * 32767)
  }
  return out
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) {
    view.setUint8(offset + i, text.charCodeAt(i))
  }
}

function clampSample(value: number): number {
  return value < -1 ? -1 : value > 1 ? 1 : value
}
