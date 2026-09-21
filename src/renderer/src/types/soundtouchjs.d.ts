// Types for soundtouchjs.
//
// The package ships ESM only and no declarations, so this covers the slice of it
// the audio engine uses and nothing else. Anything added here has to stay true
// to `node_modules/soundtouchjs/dist/soundtouch.js` — it is a transcription, not
// a wish list.

declare module 'soundtouchjs' {
  /**
   * The time-stretch / resample pair, driven by three independent factors.
   *
   * `rate` changes speed and pitch together, `tempo` changes speed alone, and
   * `pitch` changes pitch alone — which is why a pitch shift is expressed here as
   * a pitch and not as a playback rate. Setting one recomputes the other two.
   */
  export class SoundTouch {
    constructor()
    /** Pitch as a frequency ratio. 1 sounds the input as recorded. */
    pitch: number
    /** Pitch as octaves. */
    pitchOctaves: number
    /** Pitch as semitones, which is the unit a note stores. */
    pitchSemitones: number
    /** Speed, changing pitch with it. */
    rate: number
    /** Speed on its own. */
    tempo: number
    clear(): void
  }

  /** Anything the filter can pull interleaved stereo frames from. */
  export interface FrameSource {
    /** Read up to `numFrames` frames from `position`. 0 once drained. */
    extract(target: Float32Array, numFrames?: number, position?: number): number
  }

  /**
   * Pull-based driver: `extract` feeds the source through the pipe and hands back
   * whatever comes out. Nothing here is tied to an audio node, so it can be run
   * as fast as the caller cares to ask.
   *
   * It only pumps the pipe once it holds a full 8192-frame block of input:
   * a source that cannot fill one produces no output at all, and one that reads
   * short stops it for good.
   */
  export class SimpleFilter {
    constructor(source: FrameSource, pipe: SoundTouch, callback?: () => void)
    /** Write up to `numFrames` interleaved frames into `target`. 0 at the end. */
    extract(target: Float32Array, numFrames?: number): number
    clear(): void
  }
}
