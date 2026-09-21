// Offline rendering and WAV encoding for 导出音频.
//
// The live engine's graph is rebuilt here for a different context. An
// OfflineAudioContext renders as fast as the machine can rather than in real
// time, which is the point of it: a three-minute song comes back in seconds.
//
// Graph per channel, mirroring `engine.ts` exactly:
//
//   AudioBufferSourceNode -> GainNode -> GainNode -> StereoPannerNode -> master -> destination
//        (per note)        (velocity)  (channel strip)
//
// The project has no effect nodes. A channel's chain is a gain and a panner and
// nothing else, so "wire up the effects" is those two, copied across holding the
// values they hold right now — which is what makes the export sound like what
// was on screen.
//
// Nothing in here reads the store: the caller flattens the song into
// `ExportVoice`s first. That keeps the render the same code whatever the
// timeline was made of, and keeps the store out of the DSP.

import { Mp3Encoder } from '@breezystack/lamejs'

import { gainForVelocity, pitchShiftedBuffer } from './engine'
import type { Note } from '../types/note'

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

/** One channel's part of the mix. */
export type ExportVoice = {
  buffer: AudioBuffer
  /** The channel's own gain, with mute and solo already folded in. */
  gain: number
  /** -1 to 1. */
  pan: number
  /** Notes in seconds, from the start of the song. */
  notes: Note[]
}

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

    // The strip outlives the notes the way it does live: one gain and one panner
    // for the channel, with every voice of it hanging off the same pair.
    const stripGain = offline.createGain()
    stripGain.gain.value = voice.gain
    const panner = offline.createStereoPanner()
    panner.pan.value = Math.min(Math.max(voice.pan, -1), 1)
    stripGain.connect(panner)
    panner.connect(master)

    for (const note of notes) {
      const source = offline.createBufferSource()
      source.buffer = pitchShiftedBuffer(voice.buffer, note.pitch)

      const velocityGain = offline.createGain()
      velocityGain.gain.value = gainForVelocity(note.velocity)
      source.connect(velocityGain)
      velocityGain.connect(stripGain)

      source.start(note.startSec)
      source.stop(note.startSec + note.lengthSec)
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
 * Render every distinct (sample, pitch) pair the song needs, in chunks.
 *
 * Pitch 0 is skipped: that is the sample itself, and `pitchShiftedBuffer` hands
 * it straight back without rendering anything.
 */
async function warmPitchCache(
  voices: ExportVoice[],
  onProgress: (progress: ExportProgress) => void
): Promise<void> {
  const seen = new Map<AudioBuffer, Set<number>>()
  const pending: { buffer: AudioBuffer; pitch: number }[] = []

  for (const voice of voices) {
    for (const note of voice.notes) {
      if (note.pitch === 0 || note.lengthSec <= 0) continue
      let pitches = seen.get(voice.buffer)
      if (!pitches) {
        pitches = new Set()
        seen.set(voice.buffer, pitches)
      }
      if (pitches.has(note.pitch)) continue
      pitches.add(note.pitch)
      pending.push({ buffer: voice.buffer, pitch: note.pitch })
    }
  }

  if (pending.length === 0) {
    onProgress({ stage: 'prepare', ratio: 1 })
    return
  }

  pending.forEach((item, index) => {
    // The return value is not wanted; the point is the cache it leaves behind.
    pitchShiftedBuffer(item.buffer, item.pitch)
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
