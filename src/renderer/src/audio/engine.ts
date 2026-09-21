// Audio engine — the single owner of the AudioContext for the whole app.
//
// Rules this module exists to enforce (see CLAUDE.md):
// - exactly one AudioContext, created lazily on the first user gesture
// - every time value is seconds, read from AudioContext.currentTime
// - playback is scheduled on the audio clock, never with setInterval/setTimeout
//
// No React and no store access here: this is plain, testable Web Audio.

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

type ActivePlayback = {
  source: AudioBufferSourceNode
  /** AudioContext.currentTime at which the source was scheduled. */
  startedAtSec: number
}

let activePlayback: ActivePlayback | null = null

/**
 * Play a buffer starting now, on the audio clock.
 *
 * `onEnded` fires only when the sample reaches its natural end — never when the
 * playback was superseded by another `playBuffer` or cut short by
 * `stopPlayback`, so callers can treat it as "finished on its own".
 *
 * Returns the audio-clock time (seconds) the playback was scheduled at.
 */
export function playBuffer(buffer: AudioBuffer, onEnded: () => void): number {
  const context = getAudioContext()
  stopPlayback()

  const source = context.createBufferSource()
  source.buffer = buffer
  source.connect(context.destination)

  const startedAtSec = context.currentTime
  activePlayback = { source, startedAtSec }

  source.onended = () => {
    // A source that was stopped also fires onended; ignore those, since
    // stopPlayback/playBuffer already cleared activePlayback.
    if (activePlayback?.source !== source) return
    activePlayback = null
    onEnded()
  }

  source.start(startedAtSec)
  return startedAtSec
}

/** Stop whatever is playing, if anything. Safe to call when nothing plays. */
export function stopPlayback(): void {
  const playback = activePlayback
  if (!playback) return

  // Clear before stopping so the onended handler above reads this as a cut,
  // not as a natural finish.
  activePlayback = null
  playback.source.onended = null
  playback.source.stop()
  playback.source.disconnect()
}

/** True while a buffer is sounding. */
export function isPlaying(): boolean {
  return activePlayback !== null
}
