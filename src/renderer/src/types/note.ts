// Piano Roll data, grid geometry, and the project tempo.
//
// Seconds are the only unit that reaches the audio clock, so seconds are what a
// note stores. Bars and beats are a presentation layer drawn on top of them, and
// the tempo is the bridge between the two. That is why every derived value below
// is a function of the tempo rather than a constant: moving the tempo has to move
// the grid, the snapping and the note lengths together, or the ruler would stop
// describing what is being heard.
//
// The one value a note's seconds depend on that the tempo cannot supply is how
// long the pattern is. That belongs to the pattern (see `Pattern.lengthBars`), so
// the clamps below take it as an argument rather than reading it from here.

/** One note in a channel's sequence. */
export type Note = {
  id: string
  /** Start of the note, in seconds from the start of the sequence. */
  startSec: number
  /** How long the sample is held, in seconds. */
  lengthSec: number
  /** Semitone offset from the sample's own pitch. 0 plays it as recorded. */
  pitch: number
  /** How hard the note is played, 0..127. Scales that voice's gain. */
  velocity: number
}

/** Velocity a freshly drawn note gets: comfortably above the middle. */
export const DEFAULT_VELOCITY = 100

/** The tempo an empty project starts at. */
export const DEFAULT_BPM = 120
/**
 * Tempo bounds. Slow enough to be a crawl, fast enough to be a drum roll — and
 * capped at the top because the step loop reserves ahead in real time, so a
 * tempo whose steps outpace that reservation would starve it.
 */
export const MIN_BPM = 40
export const MAX_BPM = 240

export const BEATS_PER_BAR = 4

export function secondsPerBeat(bpm: number): number {
  return 60 / bpm
}

export function secondsPerBar(bpm: number): number {
  return secondsPerBeat(bpm) * BEATS_PER_BAR
}

/** Grid resolution: a 1/16 note. At 120 BPM a step is exactly 0.125s. */
export const STEPS_PER_BEAT = 4

export function secondsPerStep(bpm: number): number {
  return 60 / bpm / STEPS_PER_BEAT
}

/**
 * The resolutions the piano roll's grid can be set to, as divisions of a beat.
 *
 * 4 is a 1/16 note, which is where a pattern usually starts; the finer end is
 * what lets a note be placed or held for a 1/64. This is the *snap* grid, which
 * is a separate question from the step sequencer's own 1/16 grid — that one is
 * fixed by `STEPS_PER_BEAT` and is not affected by this.
 */
export const GRID_DIVISIONS = [1, 2, 4, 8, 16] as const
export type GridDivision = (typeof GRID_DIVISIONS)[number]
export const DEFAULT_GRID_DIVISION: GridDivision = STEPS_PER_BEAT

/** What a division is called: 1 division per beat is a 1/4 note. */
export function gridLabel(division: number): string {
  return `1/${division * 4}`
}

/** One grid cell at a division, in seconds. */
export function secondsPerGrid(bpm: number, division: number): number {
  return 60 / bpm / division
}

/**
 * How long a pattern can be, in bars.
 *
 * Belongs to the pattern rather than to the module, because a pattern is the
 * unit that has a length: the piano roll edits up to it, and the playlist places
 * whole repeats of it. A default of 16 is long enough to write a section in
 * without scrolling and short enough to see the whole grid.
 */
export const LENGTH_BAR_OPTIONS = [4, 8, 16, 32, 64] as const
export const DEFAULT_LENGTH_BARS = 16
export const MIN_LENGTH_BARS = 4
export const MAX_LENGTH_BARS = 64

/** Keep a pattern length inside the range, as a whole number of bars. */
export function clampLengthBars(lengthBars: number): number {
  return Math.min(Math.max(Math.round(lengthBars), MIN_LENGTH_BARS), MAX_LENGTH_BARS)
}

/** How long one pass of a pattern is, in seconds. */
export function sequenceSec(bpm: number, lengthBars: number): number {
  return lengthBars * secondsPerBar(bpm)
}

/** How many 1/16 steps fit in one pattern. */
export function sequenceSteps(lengthBars: number): number {
  return lengthBars * BEATS_PER_BAR * STEPS_PER_BEAT
}

/** Length a freshly drawn note gets: one cell of the grid it is drawn on. */
export function defaultNoteSec(bpm: number, division: number = STEPS_PER_BEAT): number {
  return secondsPerGrid(bpm, division)
}

/**
 * Shortest a note can be dragged down to: one grid cell.
 *
 * Tied to the grid rather than to a fixed 1/16 because a note shorter than the
 * grid it is placed on could never be positioned where it was put.
 */
export function minNoteSec(bpm: number, division: number = STEPS_PER_BEAT): number {
  return secondsPerGrid(bpm, division)
}

// Piano keyboard.
//
// The vertical axis is four octaves of keys with the sample's own pitch in the
// middle. That is what fixes a note's semitone offset to -24..+24: everything the
// keyboard can point at, and nothing it cannot. Four octaves is more than fits on
// screen at the default key height, which is what vertical scrolling and zooming
// are for — the range is what is reachable, not what is visible.

export const KEY_HEIGHT_PX = 16
export const LOWEST_PITCH = -24
export const HIGHEST_PITCH = 24
export const PIANO_KEY_COUNT = HIGHEST_PITCH - LOWEST_PITCH + 1

/** Width of one 1/16 step on the time axis, in pixels. */
export const STEP_PX = 12

// Zoom bounds, as the pixels one 1/16 step and one key take up. The floor is
// where a step is still clickable and a key still readable; the ceiling is where
// the finest grid the roll offers (a 1/64) is still a few pixels wide, so that a
// note can be both placed and grabbed at the resolution it was drawn at.
export const MIN_STEP_PX = 3
export const MAX_STEP_PX = 256
export const MIN_KEY_PX = 7
export const MAX_KEY_PX = 48

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

/** Semitones within an octave that are black keys. */
const BLACK_KEY_CLASSES = new Set([1, 3, 6, 8, 10])

/** Where a pitch sits within its octave, 0 = C. Negative pitches included. */
export function pitchClass(pitch: number): number {
  return ((pitch % 12) + 12) % 12
}

export function isBlackKey(pitch: number): boolean {
  return BLACK_KEY_CLASSES.has(pitchClass(pitch))
}

/**
 * What a key is called.
 *
 * Offsets are named as if the sample's own pitch were C4, which is the only
 * reference a sampler that does not know its root note can offer. The name is
 * therefore a label on the offset, not a claim about the sample.
 */
export function noteName(pitch: number): string {
  return `${NOTE_NAMES[pitchClass(pitch)]}${4 + Math.floor(pitch / 12)}`
}

/** Grid row for a semitone offset. Row 0 is the top key, so pitch counts up. */
export function rowForPitch(pitch: number): number {
  return HIGHEST_PITCH - pitch
}

/** Semitone offset for a grid row. */
export function pitchForRow(row: number): number {
  return HIGHEST_PITCH - row
}

/** Keep a row index inside the grid. */
export function clampRow(row: number): number {
  return Math.min(PIANO_KEY_COUNT - 1, Math.max(0, row))
}

/** Keep a semitone offset on the keyboard. */
export function clampPitch(pitch: number): number {
  return Math.min(HIGHEST_PITCH, Math.max(LOWEST_PITCH, pitch))
}

/** Snap a time to the nearest grid line. */
export function snapSec(seconds: number, bpm: number, division: number = STEPS_PER_BEAT): number {
  const cellSec = secondsPerGrid(bpm, division)
  return Math.round(seconds / cellSec) * cellSec
}

/** Clamp a note's start so that a note of `lengthSec` stays inside the pattern. */
export function clampNoteStart(
  startSec: number,
  lengthSec: number,
  bpm: number,
  lengthBars: number
): number {
  return Math.min(Math.max(0, startSec), Math.max(0, sequenceSec(bpm, lengthBars) - lengthSec))
}

/** Clamp a note's length so that it stays inside the pattern. */
export function clampNoteLength(
  lengthSec: number,
  startSec: number,
  bpm: number,
  lengthBars: number,
  division: number = STEPS_PER_BEAT
): number {
  return Math.min(
    Math.max(minNoteSec(bpm, division), lengthSec),
    sequenceSec(bpm, lengthBars) - startSec
  )
}
