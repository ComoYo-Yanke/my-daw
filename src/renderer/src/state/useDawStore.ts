import { create } from 'zustand'
import {
  createStrip,
  decodeAudioData,
  getAudioContext,
  getStrip,
  playArrangement,
  playNoteSequence,
  resumeAudioContext,
  scheduleNoteSequence,
  setStripGain,
  setStripPan,
  stopAllStrips,
  stopStrip,
  triggerStrip
} from '../audio/engine'
import type { ScheduledChannel } from '../audio/engine'
import { computePeaks } from '../audio/peaks'
import {
  clampLengthBars,
  clampNoteLength,
  clampNoteStart,
  DEFAULT_BPM,
  DEFAULT_GRID_DIVISION,
  DEFAULT_LENGTH_BARS,
  DEFAULT_VELOCITY,
  defaultNoteSec,
  HIGHEST_PITCH,
  LOWEST_PITCH,
  MAX_BPM,
  MIN_BPM,
  minNoteSec,
  secondsPerBar,
  secondsPerGrid,
  sequenceSec,
  snapSec,
  type GridDivision,
  type Note
} from '../types/note'
import {
  DEFAULT_STEP_COUNT,
  EMPTY_STEPS,
  hasSteps,
  hitLengthSec,
  loopCursorAt,
  nextFiringStep,
  stepGapSec,
  stepSequenceSec,
  withStepToggled,
  type StepCount,
  type StepGrid
} from '../types/step'

/** A decoded sample, plus its cached peak envelope for the thumbnail. */
export type Sample = {
  id: string
  name: string
  path: string
  /** Length in seconds, taken from the decoded AudioBuffer. */
  durationSec: number
  /** Decoded PCM. Shared by every channel that plays this sample. */
  buffer: AudioBuffer
  peaks: Float32Array
}

/**
 * A rack channel: one mixer strip that plays one sample.
 *
 * Channels are what the user tweaks; samples are just the audio they point at.
 * Several channels may share one `sampleId` with independent params.
 *
 * A channel deliberately holds no notes: *how* a sample sounds is a channel's
 * business, *when* it plays belongs to a pattern (see `Pattern`).
 */
export type Channel = {
  id: string
  name: string
  sampleId: string
  /** 0..1 */
  volume: number
  /** -1 (hard left) .. 1 (hard right) */
  pan: number
  muted: boolean
  soloed: boolean
  /** What this channel's switched-on steps are filled with, so a rack of them
   *  is readable at a glance. Handed out from `STEP_COLORS` on creation. */
  color: string
  /** Steps this channel's loop runs: 4, 8, 16 or 32. A view onto the grid, not
   *  a cut of it — see `StepGrid`. */
  stepCount: StepCount
  /** 0 (straight) .. 100 (off-beat steps half a step late). */
  swing: number
}

/**
 * A pattern: the note content of the whole rack, per channel.
 *
 * This is the FL Studio split — the rack holds the instruments, patterns hold
 * the arrangements. One rack of channels therefore plays a different piece of
 * music per pattern, with the mixer untouched.
 */
export type Pattern = {
  id: string
  name: string
  /**
   * How long this pattern is, in bars.
   *
   * It is the pattern's own length rather than a project-wide setting because a
   * pattern is the unit that has one: the piano roll edits up to it, and the
   * playlist places whole repeats of it. Two patterns of different lengths can
   * therefore sit on the same timeline.
   */
  lengthBars: number
  /** Notes per channel id. A channel with no entry here simply has none. */
  notesByChannel: Record<string, Note[]>
  /**
   * Step-sequencer grid per channel id — the same split as `notesByChannel`, so
   * a pattern carries both ways of playing the rack and switching pattern
   * switches both. A channel with no entry has nothing switched on.
   */
  stepsByChannel: Record<string, StepGrid>
}

/**
 * One block of a pattern placed on the song timeline.
 *
 * `lengthBars` is always a whole number of patterns: a clip is an *arrangement*
 * of a pattern, so a clip twice the pattern's length plays it twice. That is
 * what makes length worth dragging.
 */
export type PlaylistClip = {
  id: string
  patternId: string
  /** Where the clip starts, in bars from the top of the song. */
  startBar: number
  /** How long it runs, in bars — always a multiple of the pattern's length. */
  lengthBars: number
}

/** Which view the project is in, and which one the transport plays. */
export type PlayMode = 'pattern' | 'song'

/**
 * What the transport is running.
 *
 * `steps` is the odd one out. The others have a length and stop themselves when
 * it runs out; the step loop has no end and runs until it is stopped, so it keeps
 * reserving its own next pass instead of reporting a finish.
 *
 * `piano-roll` is `pattern` with a clock of its own: it reserves the pattern bar
 * by bar so the tempo and the notes can be read fresh as it goes, and it can wrap
 * round to the top instead of ending. That is also why it needs a mode of its own
 * — its position is not `currentTime - startedAtSec`, it is where the reservation
 * says the clock is.
 */
export type PlaybackMode = PlayMode | 'steps' | 'piano-roll'

/** What the transport is playing right now. */
export type Playback = {
  mode: PlaybackMode
  /** Pattern mode only: the channel whose sequence is running. */
  channelId: string | null
  /**
   * The channels this playback put voices on, so stopping cuts exactly those and
   * leaves unrelated one-shot previews alone.
   */
  channelIds: string[]
  /**
   * Audio-clock time playback started at, in seconds. For `steps` this is the
   * origin the cursor wraps around, so it moves if the loop has to be restarted.
   */
  startedAtSec: number
  /**
   * Audio-clock time it ends at, in seconds, for the progress readout. For a
   * looping step playback that is one pass, not the end of anything.
   */
  endsAtSec: number
}

/**
 * Shortest the song timeline gets, in bars.
 *
 * Unlike a pattern's length this is not fixed: a clip is a whole number of
 * repeats of its pattern, so the timeline has to be at least as long as the
 * longest pattern or that pattern could never be placed on it. This is the floor
 * it grows from.
 */
export const MIN_PLAYLIST_BARS = 32

/**
 * Shared empty sequence.
 *
 * Selectors must return the same array between renders for a channel that has no
 * notes, or every store change would re-render every row.
 */
const NO_NOTES: Note[] = []

/** New-channel defaults, also used as the knobs' double-click reset values. */
export const DEFAULT_VOLUME = 0.8
export const DEFAULT_PAN = 0
/** Name of the pattern an empty project starts with. */
export const FIRST_PATTERN_NAME = 'Pattern 1'
/** Base name for the patterns created from the UI. */
export const PATTERN_NAME_BASE = 'Pattern'

export type DawState = {
  /** The sample pool: decoded audio, imported once and shared. */
  samples: Sample[]
  channels: Channel[]
  /** Every pattern in the project. Never empty: a project always has one. */
  patterns: Pattern[]
  /** The pattern the rack and the piano roll are currently editing. */
  currentPatternId: string
  /** Channels with at least one voice sounding, for the row indicators. */
  playingChannelIds: string[]
  isImporting: boolean
  /** Last user-facing failure, cleared by `clearError`. */
  error: string | null

  /** The song arrangement: which pattern plays where. */
  playlistClips: PlaylistClip[]
  /** Which view is showing, and what the transport plays. */
  playMode: PlayMode
  /** Highlighted clip, or null. */
  selectedClipId: string | null

  /** Channel whose Piano Roll panel is open, or null when the panel is closed. */
  pianoRollChannelId: string | null
  /**
   * Whether the piano roll's transport wraps round to the top of the pattern
   * instead of stopping at the end. A property of the transport rather than of a
   * pattern: it says how to play, not what to play.
   */
  loopEnabled: boolean
  /**
   * Where the piano roll's transport starts from, in seconds into the pattern.
   *
   * A property of the transport, not of the pattern: it says where to play from,
   * not what to play. It is the white line the grid draws when stopped, and it is
   * what a loop wraps back to.
   */
  pianoRollStartSec: number
  /**
   * Whether dragging lands on the grid.
   *
   * Off, notes go exactly where the pointer is and hold for exactly as long as it
   * is dragged — for the times a note wants to sit between two grid lines, which
   * a sampler part often does.
   */
  snapEnabled: boolean
  /** The grid a dragged note lands on, as divisions of a beat. */
  gridDivision: GridDivision
  /**
   * The running transport, or null when stopped. The playhead is derived from
   * `startedAtSec` and `AudioContext.currentTime`, never counted up.
   */
  playback: Playback | null
  /** Project tempo, in beats per minute. Everything timed follows it. */
  bpm: number

  setBpm: (bpm: number) => void
  /** Take back the last edit, across every kind of edit the store has. */
  undo: () => void
  importSamples: () => Promise<void>
  triggerChannel: (channelId: string) => Promise<void>
  stopAll: () => void
  renameChannel: (channelId: string, name: string) => void
  setVolume: (channelId: string, volume: number) => void
  setPan: (channelId: string, pan: number) => void
  toggleMute: (channelId: string) => void
  toggleSolo: (channelId: string) => void
  duplicateChannel: (channelId: string) => void
  clearError: () => void

  selectPattern: (patternId: string) => void
  addPattern: () => void
  renamePattern: (patternId: string, name: string) => void
  setPatternLengthBars: (lengthBars: number) => void

  openPianoRoll: (channelId: string) => void
  closePianoRoll: () => void
  toggleLoop: () => void
  /** Move the transport's start, in seconds into the pattern. */
  setPianoRollStart: (startSec: number) => void
  toggleSnap: () => void
  setGridDivision: (division: GridDivision) => void
  /**
   * Add a note where the user clicked, and hand it back.
   *
   * Returns the note rather than an id so a caller that is about to drag its
   * length — which is how a note is drawn — has the legal note to measure from,
   * rather than the position it asked for.
   */
  addNote: (channelId: string, startSec: number, pitch: number, snap?: boolean) => Note
  /** Add notes that already exist, as they are — what a paste and a duplicate do. */
  addNotes: (channelId: string, notes: Note[]) => void
  /**
   * Move a set of notes together, as one rigid group.
   *
   * `origins` are the notes as they were when the drag started, and the delta is
   * measured from there rather than accumulated, so a drag that wanders and comes
   * back lands exactly where it started. The group is clamped as a whole: the note
   * that reaches the edge stops the group rather than being squashed against it,
   * which is what keeps the spacing inside the group intact.
   *
   * A single note is just a group of one.
   *
   * `snap` is the grid the drag is landing on: true for the 1/16 steps, false
   * while Alt is held. Clamping to the pattern happens either way — Alt is a
   * finer grid, not an escape from the pattern.
   */
  moveNotes: (
    channelId: string,
    origins: Note[],
    deltaSec: number,
    deltaPitch: number,
    snap?: boolean
  ) => void
  /**
   * Change the length of a set of notes together, as one rigid group.
   *
   * The twin of `moveNotes`: `origins` are the notes as they were when the drag
   * started, and the delta is a change in *length* rather than in position, so
   * every note in the group grows or shrinks by the same amount and their starts
   * do not move. The group is clamped as a whole, so the note that reaches the
   * pattern's end stops the group rather than being squashed against it.
   */
  resizeNotes: (channelId: string, origins: Note[], deltaSec: number, snap?: boolean) => void
  removeNote: (channelId: string, noteId: string) => void
  removeNotes: (channelId: string, noteIds: string[]) => void
  /** Sound one pitch through a channel, for auditioning a piano key. */
  previewPitch: (channelId: string, pitch: number) => Promise<void>
  /** How far into the pattern the piano roll's transport has got, or null. */
  pianoRollPositionAt: (atSec: number) => number | null
  toggleStep: (channelId: string, step: number) => void
  setStepCount: (channelId: string, stepCount: StepCount) => void
  setSwing: (channelId: string, swing: number) => void
  /** Which step of a channel's loop was sounding at an audio-clock time. */
  soundingStepAt: (channelId: string, atSec: number) => number | null
  playChannelSequence: (channelId: string) => Promise<void>
  /** Start the piano roll's own transport for a channel: bar by bar, and looping. */
  playPianoRoll: (channelId: string) => Promise<void>
  playSteps: () => Promise<void>
  playSong: () => Promise<void>
  stopSequence: () => void

  setPlayMode: (mode: PlayMode) => void
  addClip: (startBar: number) => void
  moveClip: (clipId: string, startBar: number) => void
  resizeClip: (clipId: string, lengthBars: number) => void
  removeClip: (clipId: string) => void
  selectClip: (clipId: string | null) => void
}

/**
 * IPC hands the file over as a Uint8Array, which may be a view over a larger
 * buffer. decodeAudioData needs an ArrayBuffer covering exactly those bytes.
 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/** "Kick" -> "Kick 2", skipping names that are already taken. */
function nextNumberedName(base: string, taken: string[]): string {
  let index = 2
  while (taken.includes(`${base} ${index}`)) {
    index += 1
  }
  return `${base} ${index}`
}

function makePattern(name: string): Pattern {
  return {
    id: crypto.randomUUID(),
    name,
    lengthBars: DEFAULT_LENGTH_BARS,
    notesByChannel: {},
    stepsByChannel: {}
  }
}

/** Rebuild a notes-per-channel map, applying `update` to each channel's notes. */
function mapNotes(
  notesByChannel: Record<string, Note[]>,
  update: (notes: Note[]) => Note[]
): Record<string, Note[]> {
  return Object.fromEntries(
    Object.entries(notesByChannel).map(([channelId, notes]) => [channelId, update(notes)])
  )
}

/** The pattern being edited, or undefined only if the id ever goes stale. */
export function selectCurrentPattern(state: DawState): Pattern | undefined {
  return state.patterns.find((pattern) => pattern.id === state.currentPatternId)
}

/** How long the pattern being edited is, in bars. */
export function selectLengthBars(state: DawState): number {
  return selectCurrentPattern(state)?.lengthBars ?? DEFAULT_LENGTH_BARS
}

/**
 * How many bars the song timeline shows.
 *
 * Grows to fit the longest pattern, because a clip is a whole number of repeats
 * of its pattern and a pattern longer than the timeline could never be placed.
 */
export function selectPlaylistBars(state: DawState): number {
  return state.patterns.reduce(
    (bars, pattern) => Math.max(bars, pattern.lengthBars),
    MIN_PLAYLIST_BARS
  )
}

/**
 * Where the piano roll's transport starts, held inside the pattern.
 *
 * Clamped on the way out rather than kept in range, because what it has to fit
 * inside — the pattern's length, at the current tempo — can change without the
 * cursor being touched. The margin is a grid cell, which is also what guarantees
 * the transport is always started with a real slice of pattern in front of it.
 */
export function selectPianoRollStartSec(state: DawState): number {
  const totalSec = sequenceSec(state.bpm, selectLengthBars(state))
  const marginSec = secondsPerGrid(state.bpm, state.gridDivision)
  return clamp(state.pianoRollStartSec, 0, Math.max(0, totalSec - marginSec))
}

/**
 * A channel's notes in the current pattern.
 *
 * Returns the shared `NO_NOTES` array when the channel has none, so subscribing
 * components see a stable reference and stay still on unrelated store changes.
 */
export function selectNotes(state: DawState, channelId: string): Note[] {
  return selectCurrentPattern(state)?.notesByChannel[channelId] ?? NO_NOTES
}

/**
 * A channel's step grid in the current pattern.
 *
 * Same contract as `selectNotes`: a channel with nothing switched on reads as the
 * shared `EMPTY_STEPS`, so the row stays still on unrelated store changes.
 */
export function selectSteps(state: DawState, channelId: string): StepGrid {
  return selectCurrentPattern(state)?.stepsByChannel[channelId] ?? EMPTY_STEPS
}

/**
 * The running playback, but only when it is this channel's own sequence.
 *
 * Song playback has no single channel, so it never matches — which is what keeps
 * a channel row from claiming the whole song as "its" playback.
 */
export function selectChannelPlayback(state: DawState, channelId: string): Playback | null {
  return state.playback?.channelId === channelId ? state.playback : null
}

/**
 * How far left this clip could slide without landing on its left neighbour.
 *
 * Clips never overlap, so a clip already on the timeline is always inside a free
 * gap and these two bounds are well defined.
 */
function freeFrom(clips: PlaylistClip[], clip: PlaylistClip): number {
  return clips.reduce((limit, other) => {
    if (other.id === clip.id) return limit
    const end = other.startBar + other.lengthBars
    return end <= clip.startBar ? Math.max(limit, end) : limit
  }, 0)
}

/** How far right this clip could reach: its right neighbour's start bar. */
function freeTo(clips: PlaylistClip[], clip: PlaylistClip, playlistBars: number): number {
  const clipEnd = clip.startBar + clip.lengthBars
  return clips.reduce((limit, other) => {
    if (other.id === clip.id) return limit
    return other.startBar >= clipEnd ? Math.min(limit, other.startBar) : limit
  }, playlistBars)
}

/**
 * Where a clip of `lengthBars` bars can be placed at or after `desiredBar`.
 *
 * Walks the free gaps left to right, so clicking on top of an existing clip
 * lands the new one in the next gap rather than on top of it. Null when the
 * timeline has no room left — which a pattern as long as the timeline can hit.
 */
function findClipSlot(
  clips: PlaylistClip[],
  desiredBar: number,
  lengthBars: number,
  playlistBars: number
): number | null {
  const latest = playlistBars - lengthBars
  let bar = Math.min(Math.max(0, Math.round(desiredBar)), Math.max(0, latest))

  for (const clip of [...clips].sort((a, b) => a.startBar - b.startBar)) {
    if (clip.startBar + clip.lengthBars <= bar) continue // Already behind us.
    if (clip.startBar >= bar + lengthBars) break // Fits before this one.
    bar = clip.startBar + clip.lengthBars
  }

  return bar <= latest ? bar : null
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/**
 * How far ahead of the audio clock steps are reserved, in seconds.
 *
 * This is the whole latency of the step sequencer: it is how long it takes a
 * toggled step, a new swing setting or a new tempo to be heard, and how much
 * audio a stalled wake-up has to get through before the loop runs dry. Steps are
 * reserved one at a time rather than a pass at a time precisely so this can be
 * short without the loop stuttering.
 */
const STEP_LOOKAHEAD_SEC = 0.4

/**
 * How many reserved steps a channel's cursor remembers.
 *
 * The reservation always runs ahead of the clock, so it cannot answer "which
 * step is sounding now" — but its own history can, and that is what the
 * highlight reads. Has to reach back over the lookahead at the fastest tempo:
 * 240 BPM gives 16 steps a second, so a handful is plenty.
 */
const RECENT_STEPS = 12

/** A step that has been handed to the audio clock, and when it fires. */
type ReservedStep = {
  index: number
  atSec: number
}

/** Where one channel's loop has got to. */
type ChannelLoop = {
  /** Index of the next step to reserve. */
  index: number
  /** Audio-clock time that step fires at. */
  atSec: number
  /** The last few reserved steps, oldest first. */
  recent: ReservedStep[]
}

/** A running step loop: how to stop it, and where each channel has got to. */
type StepLoop = {
  frame: number
  /** Per channel, because a pass is as long as that channel's step count. */
  channels: Map<string, ChannelLoop>
}

/**
 * How far ahead of the audio clock the piano roll reserves, in seconds.
 *
 * A bar of bars is reserved at a time, and a bar is never shorter than a second
 * even at the fastest tempo, so this always covers less than one bar: each tick
 * reserves the next bar and no more. That is what keeps the latency of an edit
 * down to about a bar — a note drawn while the transport runs is heard on the
 * next one rather than at the end of the pattern.
 */
const PIANO_ROLL_LOOKAHEAD_SEC = 0.5

/**
 * How many reserved bars the cursor remembers.
 *
 * The reservation runs ahead of the clock, so it cannot answer "where is the
 * playhead now" — but its own history can, and that is what the cursor reads.
 * Two would do at any reachable tempo; a few more cost nothing and cover a
 * lookahead that has grown past a bar on a very slow one.
 */
const RECENT_BARS = 4

/**
 * How close to a bar line counts as being on it, in seconds.
 *
 * Fine enough that no reachable cursor or tempo can put a real slice inside it —
 * the smallest a grid cell ever gets is a 1/64 at the fastest tempo, a sixtieth
 * of a second — and coarse enough to swallow the error of dividing a bar length
 * into a cursor position.
 */
const BAR_EPSILON_SEC = 1e-4

/**
 * How many edits can be taken back.
 *
 * Each entry is a handful of references, because every action replaces the
 * objects it changes rather than editing them — so a snapshot costs an array of
 * pointers, not a copy of the project.
 */
const UNDO_DEPTH = 50

/**
 * How long an edit of the same kind keeps folding into the previous undo step.
 *
 * A knob dragged across its range is one change, not sixty: without this, one
 * gesture would fill the whole history and Ctrl+Z would walk back through it a
 * pixel at a time.
 */
const UNDO_COALESCE_MS = 700

/** One bar of a pattern, as handed to the audio clock. */
type ReservedBar = {
  /** Audio-clock time this bar starts at. */
  atSec: number
  /** How long it lasts. */
  lengthSec: number
  /** Where it starts in the pattern, so the cursor can be placed on the grid. */
  sequenceStartSec: number
}

/** The piano roll's running transport. One at a time, like the step loop. */
type PianoRollLoop = {
  frame: number
  channelId: string
  /** Audio-clock time the next unreserved slice starts at. */
  nextBarAtSec: number
  /**
   * Where in the pattern the next unreserved slice starts.
   *
   * A position in the pattern rather than a bar count, because the transport can
   * start part way through a bar — it starts at the cursor — so a bar index would
   * have to carry that offset separately.
   */
  nextSequenceSec: number
  /** Where playback started, to wrap back to. The cursor, read once at start. */
  fromSec: number
  /** Slices reserved since the transport started, for the one-shot end test. */
  reservations: number
  /** The last few reserved slices, oldest first. */
  recent: ReservedBar[]
}

/**
 * Step colours, handed out in order so that neighbouring channels never come out
 * the same. Six is enough to tell a rack apart at a glance without turning into
 * a colour wheel.
 */
const STEP_COLORS = ['#6c8cff', '#e0a33c', '#48b57a', '#e06c9f', '#5bc8d6', '#b98cf0']

/** The colour for the `taken`-th channel of the rack. */
function nextStepColor(taken: number): string {
  return STEP_COLORS[taken % STEP_COLORS.length]
}

/**
 * What a channel should actually sound at, folding mute and solo into gain.
 *
 * Mute wins over solo. While anything is soloed, everything else is silenced —
 * which is why solo has to be resolved across the whole rack, not per channel.
 */
function audibleGain(channel: Channel, anySoloed: boolean): number {
  if (channel.muted) return 0
  if (anySoloed && !channel.soloed) return 0
  return channel.volume
}

export const useDawStore = create<DawState>((set, get) => {
  /**
   * What undo puts back: the project, and nothing else.
   *
   * Everything here is replaced rather than edited by every action below, so
   * holding the references is enough — a snapshot is an array of pointers, not a
   * copy of the project. That is the rule to keep if an action is ever added that
   * mutates in place: it would rewrite history along with the present.
   *
   * What is deliberately left out is everything that is not the project: the
   * samples (undoing an import would have to unload decoded audio that voices may
   * be playing through), the transport, which channel's roll is open, and the
   * snap and loop settings. Ctrl+Z takes back what was done, not where you were
   * looking or how you had the tools set.
   */
  type Snapshot = {
    bpm: number
    channels: Channel[]
    patterns: Pattern[]
    currentPatternId: string
    playlistClips: PlaylistClip[]
  }

  const snapshotOf = (state: DawState): Snapshot => ({
    bpm: state.bpm,
    channels: state.channels,
    patterns: state.patterns,
    currentPatternId: state.currentPatternId,
    playlistClips: state.playlistClips
  })

  const undoStack: Snapshot[] = []
  let lastUndoKey: string | null = null
  let lastUndoAtMs = 0

  /**
   * Remember the project as it is, before an edit changes it.
   *
   * `key` identifies the kind of edit, and is what lets a continuous gesture fold
   * into one step: dragging a knob or a note reports the same key on every move,
   * so only the first move records anything and the rest ride on it. A different
   * key, or a pause, starts a new step.
   */
  const pushUndo = (key: string): void => {
    const nowMs = performance.now()
    if (key === lastUndoKey && nowMs - lastUndoAtMs < UNDO_COALESCE_MS) {
      lastUndoAtMs = nowMs
      return
    }
    lastUndoKey = key
    lastUndoAtMs = nowMs

    undoStack.push(snapshotOf(get()))
    if (undoStack.length > UNDO_DEPTH) undoStack.shift()
  }

  /**
   * Push volume/pan/mute/solo onto the audio nodes.
   *
   * Always recomputes the whole rack, because a single solo toggle changes what
   * every other channel should sound at. Changing a param never touches the
   * decoded buffer, so nothing is re-decoded.
   */
  const applyMix = (channels: Channel[]): void => {
    const anySoloed = channels.some((channel) => channel.soloed)
    for (const channel of channels) {
      const strip = getStrip(channel.id)
      if (!strip) continue
      setStripGain(strip, audibleGain(channel, anySoloed))
      setStripPan(strip, channel.pan)
    }
  }

  /**
   * Create a channel and its audio strip together, so they can never diverge.
   *
   * `taken` is how many channels already exist, which is what picks the step
   * colour. It is passed in rather than read from the store because importing a
   * batch of samples builds every channel before any of them are added.
   */
  const makeChannel = (sampleId: string, name: string, taken: number): Channel => {
    const id = crypto.randomUUID()
    createStrip(id, (active) => {
      set((state) => ({
        playingChannelIds: active
          ? [...state.playingChannelIds, id]
          : state.playingChannelIds.filter((playing) => playing !== id)
      }))
    })
    return {
      id,
      name,
      sampleId,
      volume: DEFAULT_VOLUME,
      pan: DEFAULT_PAN,
      muted: false,
      soloed: false,
      color: nextStepColor(taken),
      stepCount: DEFAULT_STEP_COUNT,
      swing: 0
    }
  }

  /**
   * Replace one channel's notes in the current pattern, leaving every other
   * channel — and every other pattern — untouched.
   */
  const patchNotes = (channelId: string, update: (notes: Note[]) => Note[]): void => {
    const { currentPatternId } = get()
    set((state) => ({
      patterns: state.patterns.map((pattern) =>
        pattern.id === currentPatternId
          ? {
              ...pattern,
              notesByChannel: {
                ...pattern.notesByChannel,
                [channelId]: update(pattern.notesByChannel[channelId] ?? NO_NOTES)
              }
            }
          : pattern
      )
    }))
  }

  /** The step-grid twin of `patchNotes`: one channel, one pattern, nothing else. */
  const patchSteps = (channelId: string, update: (grid: StepGrid) => StepGrid): void => {
    const { currentPatternId } = get()
    set((state) => ({
      patterns: state.patterns.map((pattern) =>
        pattern.id === currentPatternId
          ? {
              ...pattern,
              stepsByChannel: {
                ...pattern.stepsByChannel,
                [channelId]: update(pattern.stepsByChannel[channelId] ?? EMPTY_STEPS)
              }
            }
          : pattern
      )
    }))
  }

  /**
   * The running step loop, or null. There is one transport, so there is at most
   * one of these.
   */
  let stepLoop: StepLoop | null = null

  const stopStepLoop = (): void => {
    if (stepLoop === null) return
    cancelAnimationFrame(stepLoop.frame)
    stepLoop = null
  }

  /**
   * Hand the audio clock every step that falls inside the lookahead window.
   *
   * Steps are reserved one at a time rather than a pass at a time so the tempo,
   * the swing and the grid can all be read fresh on each one: whatever they say
   * at this moment is what the next step sounds like, and nothing already
   * scheduled is disturbed.
   *
   * Nothing is cut here. The reservation runs ahead of the clock, so the step
   * being reserved starts after the step currently sounding has already been
   * given its end — `hitLengthSec` arranged that when it was reserved.
   */
  const reserveSteps = (): void => {
    const loop = stepLoop
    if (loop === null) return

    const state = get()
    const { bpm, playback } = state
    const nowSec = getAudioContext().currentTime
    const horizonSec = nowSec + STEP_LOOKAHEAD_SEC

    for (const channel of state.channels) {
      const { stepCount, swing, id } = channel
      const grid = selectSteps(state, id)
      let cursor = loop.channels.get(id)

      if (cursor === undefined) {
        // Switched on part way through: join at the next step of the pass, so it
        // lands in phase with the channels that were already running.
        if (playback === null || !hasSteps(grid, stepCount)) continue
        cursor = {
          ...loopCursorAt(nowSec, playback.startedAtSec, stepCount, swing, bpm),
          recent: []
        }
        loop.channels.set(id, cursor)
      }

      // The step count may have shrunk under a cursor that was already running.
      cursor.index %= stepCount

      const sample = state.samples.find((item) => item.id === channel.sampleId)
      const strip = getStrip(id)
      if (!sample || !strip) continue

      // The window was hidden long enough that waking up stopped and the
      // reservation ran out. Pick the loop up from now rather than firing the
      // whole backlog at once, which would arrive as a single burst.
      if (cursor.atSec < nowSec) cursor.atSec = nowSec

      while (cursor.atSec < horizonSec) {
        const index = cursor.index
        const atSec = cursor.atSec

        if (grid[index] === true) {
          const note: Note = {
            id: crypto.randomUUID(),
            startSec: 0,
            lengthSec: hitLengthSec(
              index,
              nextFiringStep(grid, index, stepCount),
              stepCount,
              swing,
              bpm
            ),
            pitch: 0,
            // A step grid has no velocity of its own, so a switched-on step is
            // as hard as a freshly drawn note.
            velocity: DEFAULT_VELOCITY
          }
          scheduleNoteSequence(strip, sample.buffer, [note], atSec)
        }

        cursor.recent.push({ index, atSec })
        if (cursor.recent.length > RECENT_STEPS) cursor.recent.shift()

        const next = (index + 1) % stepCount
        cursor.atSec = atSec + stepGapSec(index, next, swing, bpm)
        cursor.index = next
      }
    }
  }

  /**
   * Keep the reservation topped up.
   *
   * requestAnimationFrame is only a wake-up here — the question it answers is
   * "is it worth looking at the clock yet". Every time handed to the audio nodes
   * comes from `AudioContext.currentTime`, and nothing is played by a timer; the
   * voices were already scheduled ahead of the clock that is playing them.
   */
  const tickStepLoop = (): void => {
    if (stepLoop === null) return
    reserveSteps()
    stepLoop.frame = requestAnimationFrame(tickStepLoop)
  }

  /**
   * The running piano roll transport, or null. One at a time, like the step loop.
   */
  let pianoRollLoop: PianoRollLoop | null = null

  const stopPianoRoll = (): void => {
    if (pianoRollLoop === null) return
    cancelAnimationFrame(pianoRollLoop.frame)
    pianoRollLoop = null
  }

  /**
   * The next slice of the pattern to hand over.
   *
   * A slice is what is left of one bar from `fromSec` onwards: a whole bar when
   * the transport is on the bar line, and a part of one when it started at the
   * cursor part way through. Bar boundaries are where the grid's phase comes
   * from, so a slice always ends on one.
   *
   * `wraps` says this slice reaches the end of the pattern, so the next one comes
   * from the cursor again. The slice is never empty: `fromSec` is either the
   * cursor — which is clamped to keep a cell of room in front of it — or a bar
   * line inside the pattern, and both leave at least a grid cell of bar left.
   */
  const sliceFrom = (
    fromSec: number,
    bpm: number,
    lengthBars: number
  ): { startSec: number; lengthSec: number; wraps: boolean } => {
    const barSec = secondsPerBar(bpm)
    const totalSec = sequenceSec(bpm, lengthBars)

    // Being a hair off a bar line is being on it: a cursor placed on the grid by
    // snapping can come out a float epsilon away from the line it was aimed at,
    // and a slice a microsecond long would leave the reservation spinning on it
    // without ever reaching the next bar.
    const nearestLineSec = Math.round(fromSec / barSec) * barSec
    const startSec = Math.abs(nearestLineSec - fromSec) < BAR_EPSILON_SEC ? nearestLineSec : fromSec

    const barIndex = Math.floor(startSec / barSec + 1e-9)
    const barEndSec = Math.min((barIndex + 1) * barSec, totalSec)
    return {
      startSec,
      lengthSec: barEndSec - startSec,
      wraps: barEndSec >= totalSec - BAR_EPSILON_SEC
    }
  }

  /**
   * Hand the audio clock the bars of the pattern that fall inside the lookahead.
   *
   * Reserved a bar at a time rather than a pattern at a time so that the tempo
   * and the notes are read fresh on each one: whatever they say at this moment is
   * what the next bar sounds like, and nothing already scheduled is disturbed. A
   * note drawn while the transport runs is therefore heard on the next bar, and a
   * clipped note is picked up by the bar it is in.
   *
   * A bar is reserved whole, so a note that starts in it is scheduled with its
   * end as well — notes never straddle two reservations, which is what keeps a
   * long note from being cut at the bar line.
   */
  const reservePianoRoll = (): void => {
    const loop = pianoRollLoop
    if (loop === null) return

    const state = get()
    const nowSec = getAudioContext().currentTime
    const { bpm, loopEnabled } = state
    const lengthBars = selectLengthBars(state)

    const channel = state.channels.find((item) => item.id === loop.channelId)
    const sample = channel && state.samples.find((item) => item.id === channel.sampleId)
    const strip = getStrip(loop.channelId)

    // The channel or its sample went away underneath the transport.
    if (!channel || !sample || !strip) {
      stopPianoRoll()
      set((current) => (current.playback?.mode === 'piano-roll' ? { playback: null } : {}))
      return
    }

    // A one-shot transport has nothing left to reserve once it has reserved the
    // whole pass: the cursor has come back round to where it started. Measured
    // that way rather than against the pattern's length outright, so that
    // switching the loop off part way through finishes the pass that is playing
    // instead of cutting the reservation off short.
    const oneShotDone = (): boolean =>
      !loopEnabled && loop.reservations > 0 && loop.nextSequenceSec === loop.fromSec

    if (oneShotDone()) {
      // The voices already handed over are still to come; the clock says when.
      if (nowSec >= loop.nextBarAtSec) {
        stopPianoRoll()
        set((current) => (current.playback?.mode === 'piano-roll' ? { playback: null } : {}))
      }
      return
    }

    // The window was hidden long enough that the ticks stopped, so the clock has
    // run a bar or more past the reservation. Walk the cursor forward instead of
    // firing the whole backlog at once, which would arrive as a single burst —
    // and walk it a slice at a time, so the pattern stays in phase.
    while (
      loop.nextBarAtSec + sliceFrom(loop.nextSequenceSec, bpm, lengthBars).lengthSec <= nowSec &&
      !oneShotDone()
    ) {
      const slice = sliceFrom(loop.nextSequenceSec, bpm, lengthBars)
      loop.nextBarAtSec += slice.lengthSec
      loop.nextSequenceSec = slice.wraps ? loop.fromSec : loop.nextSequenceSec + slice.lengthSec
      loop.reservations += 1
    }

    const horizonSec = nowSec + PIANO_ROLL_LOOKAHEAD_SEC
    const notes = selectNotes(state, loop.channelId)

    while (loop.nextBarAtSec < horizonSec) {
      if (oneShotDone()) break

      const slice = sliceFrom(loop.nextSequenceSec, bpm, lengthBars)
      const sliceEndSec = slice.startSec + slice.lengthSec

      // Notes are stored from the top of the pattern, so a slice's own notes are
      // the window that starts here.
      const inSlice = notes
        .filter((note) => note.startSec >= slice.startSec && note.startSec < sliceEndSec)
        .map((note) => ({ ...note, startSec: note.startSec - slice.startSec }))

      // A slice with nothing in it is still a slice: the reservation advances
      // either way, or the transport would stall on the first rest.
      if (inSlice.length > 0) {
        scheduleNoteSequence(strip, sample.buffer, inSlice, loop.nextBarAtSec)
      }

      loop.recent.push({
        atSec: loop.nextBarAtSec,
        lengthSec: slice.lengthSec,
        sequenceStartSec: slice.startSec
      })
      if (loop.recent.length > RECENT_BARS) loop.recent.shift()

      loop.nextBarAtSec += slice.lengthSec
      loop.nextSequenceSec = slice.wraps ? loop.fromSec : sliceEndSec
      loop.reservations += 1
    }
  }

  /**
   * Keep the piano roll's reservation topped up.
   *
   * Same rule as the step loop: requestAnimationFrame is only a wake-up, every
   * time handed to the audio nodes comes from `AudioContext.currentTime`, and
   * nothing is played by a timer.
   */
  const tickPianoRoll = (): void => {
    if (pianoRollLoop === null) return
    reservePianoRoll()
    if (pianoRollLoop !== null) {
      pianoRollLoop.frame = requestAnimationFrame(tickPianoRoll)
    }
  }

  // A project always has a pattern to edit, so one exists from the start. This
  // is also where the pre-Pattern per-channel notes live now: there is no
  // persistence yet, so nothing older than this session has to be moved.
  const firstPattern = makePattern(FIRST_PATTERN_NAME)

  return {
    samples: [],
    channels: [],
    patterns: [firstPattern],
    currentPatternId: firstPattern.id,
    playingChannelIds: [],
    isImporting: false,
    error: null,
    playlistClips: [],
    playMode: 'pattern',
    selectedClipId: null,
    pianoRollChannelId: null,
    loopEnabled: false,
    pianoRollStartSec: 0,
    snapEnabled: true,
    gridDivision: DEFAULT_GRID_DIVISION,
    playback: null,
    bpm: DEFAULT_BPM,

    /**
     * Set the project tempo.
     *
     * Nothing has to be restarted to make a running step loop follow: it reads
     * the tempo again on every step it reserves, so the next step is already at
     * the new speed. The piano roll and the playlist read it the same way.
     *
     * Notes are the exception, because they are stored in seconds. A note drawn
     * on the third beat has to still be on the third beat at the new tempo, so
     * every note moves with the bar it sits in — otherwise the grid would slide
     * out from under the music the moment the tempo changed. Everything timed in
     * bars rather than seconds is derived and follows by itself.
     */
    setBpm: (bpm) => {
      const next = clamp(Math.round(bpm), MIN_BPM, MAX_BPM)
      const previous = get().bpm
      if (next === previous) return

      // Typing 128 BPM goes through 1, 12 and 128 as digits land, so this is the
      // one edit that most needs folding: a whole tempo entry is one step.
      pushUndo('bpm')

      const ratio = previous / next
      set((state) => ({
        bpm: next,
        patterns: state.patterns.map((pattern) => ({
          ...pattern,
          notesByChannel: mapNotes(pattern.notesByChannel, (notes) =>
            notes.map((note) => ({
              ...note,
              startSec: note.startSec * ratio,
              lengthSec: note.lengthSec * ratio
            }))
          )
        }))
      }))
    },

    /**
     * Take back the last edit.
     *
     * The whole project goes back, not one note: an edit is a change to what is
     * being made, and it does not matter to the person making it which fields it
     * happened to touch. Nothing that is sounding is touched, so a running
     * transport plays on — with the notes it has already reserved, and the
     * restored ones from the next bar it reserves.
     */
    undo: () => {
      const previous = undoStack.pop()
      if (previous === undefined) return

      // A different kind of edit from here on, or Ctrl+Z twice in quick
      // succession would fold the undo itself into the step it just restored.
      lastUndoKey = null
      set(previous)
      // Mute, solo, volume and pan live on the audio nodes, not in the state, so
      // the restored mix has to be pushed back onto them.
      applyMix(previous.channels)
    },

    importSamples: async () => {
      set({ isImporting: true, error: null })

      try {
        const files = await window.api.openSampleFiles()
        if (files.length === 0) {
          // User cancelled the dialog.
          set({ isImporting: false })
          return
        }

        // Still inside the click gesture, so this is allowed to resume.
        await resumeAudioContext()

        const importedSamples: Sample[] = []
        const importedChannels: Channel[] = []
        const failed: string[] = []
        const taken = get().channels.length

        for (const file of files) {
          try {
            const buffer = await decodeAudioData(toArrayBuffer(file.data))
            const name = file.name.replace(/\.[^.]+$/, '')
            const sample: Sample = {
              id: crypto.randomUUID(),
              name: file.name,
              path: file.path,
              durationSec: buffer.duration,
              buffer,
              peaks: computePeaks(buffer)
            }
            importedSamples.push(sample)
            // Importing a sample puts it in the rack, like FL's channel rack.
            importedChannels.push(makeChannel(sample.id, name, taken + importedChannels.length))
          } catch {
            failed.push(file.name)
          }
        }

        // Before the set, so the snapshot is the rack as it was. The new channels
        // are in the snapshot and the decoded audio is not, so undo takes the rows
        // away and leaves the samples loaded.
        pushUndo('import')

        set((state) => ({
          samples: [...state.samples, ...importedSamples],
          channels: [...state.channels, ...importedChannels],
          isImporting: false,
          error: failed.length > 0 ? `无法解码：${failed.join('、')}` : null
        }))
        applyMix(get().channels)
      } catch (cause) {
        set({ isImporting: false, error: `导入失败：${errorMessage(cause)}` })
      }
    },

    triggerChannel: async (channelId) => {
      const channel = get().channels.find((item) => item.id === channelId)
      if (!channel) return
      const sample = get().samples.find((item) => item.id === channel.sampleId)
      const strip = getStrip(channelId)
      if (!sample || !strip) return

      await resumeAudioContext()
      // Deliberately does not stop other channels: voices overlap, so you can
      // preview several channels at once and hear mute/solo take effect.
      triggerStrip(strip, sample.buffer)
    },

    /** Everything, including one-shot previews the transport knows nothing about. */
    stopAll: () => {
      get().stopSequence()
      stopAllStrips()
      set({ playingChannelIds: [] })
    },

    renameChannel: (channelId, name) => {
      pushUndo(`channel-name:${channelId}`)
      set((state) => ({
        channels: state.channels.map((channel) =>
          channel.id === channelId ? { ...channel, name } : channel
        )
      }))
    },

    setVolume: (channelId, volume) => {
      // One key per knob, so a drag across the whole range is a single step.
      pushUndo(`volume:${channelId}`)
      set((state) => ({
        channels: state.channels.map((channel) =>
          channel.id === channelId ? { ...channel, volume } : channel
        )
      }))
      applyMix(get().channels)
    },

    setPan: (channelId, pan) => {
      pushUndo(`pan:${channelId}`)
      set((state) => ({
        channels: state.channels.map((channel) =>
          channel.id === channelId ? { ...channel, pan } : channel
        )
      }))
      applyMix(get().channels)
    },

    toggleMute: (channelId) => {
      pushUndo(`mute:${channelId}`)
      set((state) => ({
        channels: state.channels.map((channel) =>
          channel.id === channelId ? { ...channel, muted: !channel.muted } : channel
        )
      }))
      applyMix(get().channels)
    },

    toggleSolo: (channelId) => {
      pushUndo(`solo:${channelId}`)
      set((state) => ({
        channels: state.channels.map((channel) =>
          channel.id === channelId ? { ...channel, soloed: !channel.soloed } : channel
        )
      }))
      applyMix(get().channels)
    },

    duplicateChannel: (channelId) => {
      const source = get().channels.find((channel) => channel.id === channelId)
      if (!source) return
      pushUndo(`duplicate:${channelId}`)

      // Same decoded buffer, brand new strip: independent params, no re-decode.
      const copy = makeChannel(
        source.sampleId,
        nextNumberedName(
          source.name,
          get().channels.map((c) => c.name)
        ),
        get().channels.length
      )
      copy.volume = source.volume
      copy.pan = source.pan
      copy.muted = source.muted
      copy.soloed = source.soloed
      // How the loop runs is part of the channel, so it comes along. The colour
      // deliberately does not: a copy that looks identical is a copy you cannot
      // tell apart.
      copy.stepCount = source.stepCount
      copy.swing = source.swing

      // The notes and the steps come along, like duplicating a channel in FL
      // does — but as fresh objects with fresh ids, so editing one copy never
      // touches the other. Only into the current pattern: the others are
      // different material.
      const copiedNotes = selectNotes(get(), channelId).map((note) => ({
        ...note,
        id: crypto.randomUUID()
      }))
      const copiedSteps = [...selectSteps(get(), channelId)]

      set((state) => ({
        channels: [...state.channels, copy],
        patterns: state.patterns.map((pattern) =>
          pattern.id === state.currentPatternId
            ? {
                ...pattern,
                notesByChannel: { ...pattern.notesByChannel, [copy.id]: copiedNotes },
                stepsByChannel: { ...pattern.stepsByChannel, [copy.id]: copiedSteps }
              }
            : pattern
        )
      }))
      applyMix(get().channels)
    },

    clearError: () => set({ error: null }),

    /**
     * Switch which pattern the rack and the piano roll are editing.
     *
     * Voices already scheduled belong to the pattern they were read from and
     * cannot be un-scheduled, so the transport stops rather than sounding one
     * pattern while showing another.
     */
    selectPattern: (patternId) => {
      if (patternId === get().currentPatternId) return
      get().stopSequence()
      set({ currentPatternId: patternId })
    },

    /** Add an empty pattern and switch to it. */
    addPattern: () => {
      const pattern = makePattern(
        nextNumberedName(
          PATTERN_NAME_BASE,
          get().patterns.map((item) => item.name)
        )
      )
      // The new pattern becoming the current one is part of the edit, so the
      // snapshot is taken before both — and undo puts the old one back in view.
      pushUndo('add-pattern')
      set((state) => ({ patterns: [...state.patterns, pattern] }))
      get().selectPattern(pattern.id)
    },

    renamePattern: (patternId, name) => {
      pushUndo(`pattern-name:${patternId}`)
      set((state) => ({
        patterns: state.patterns.map((pattern) =>
          pattern.id === patternId ? { ...pattern, name } : pattern
        )
      }))
    },

    /**
     * How long the pattern being edited is.
     *
     * Shrinking it can leave notes past the new end, so everything that no longer
     * fits is pulled back inside rather than left hanging off the pattern. Notes
     * are cut to fit rather than deleted: shortening a pattern and lengthening it
     * again is a way of looking at the same music, not of losing it.
     */
    setPatternLengthBars: (lengthBars) => {
      const wanted = clampLengthBars(lengthBars)
      const { bpm, currentPatternId, gridDivision } = get()

      pushUndo('pattern-length')

      set((state) => ({
        patterns: state.patterns.map((pattern) =>
          pattern.id === currentPatternId
            ? {
                ...pattern,
                lengthBars: wanted,
                notesByChannel: mapNotes(pattern.notesByChannel, (notes) =>
                  notes.map((note) => {
                    const startSec = clampNoteStart(note.startSec, note.lengthSec, bpm, wanted)
                    return {
                      ...note,
                      startSec,
                      lengthSec: clampNoteLength(
                        note.lengthSec,
                        startSec,
                        bpm,
                        wanted,
                        gridDivision
                      )
                    }
                  })
                )
              }
            : pattern
        )
      }))
    },

    /**
     * Opening a roll for a channel stops whatever was playing.
     *
     * The transport belongs to the channel it was started for, and its voices
     * cannot be un-scheduled, so switching to another channel's roll would
     * otherwise leave one channel sounding while another is edited.
     */
    openPianoRoll: (channelId) => {
      if (get().pianoRollChannelId !== channelId) {
        get().stopSequence()
      }
      set({ pianoRollChannelId: channelId })
    },

    /** Closing the panel stops its transport rather than leaving it playing on. */
    closePianoRoll: () => {
      get().stopSequence()
      set({ pianoRollChannelId: null })
    },

    toggleLoop: () => set((state) => ({ loopEnabled: !state.loopEnabled })),

    /**
     * Move where the transport starts.
     *
     * Clamped here as well as when read, so that dragging the cursor past the end
     * of the pattern parks it at the end rather than storing a position the next
     * tempo change would have to be reasoned about from.
     */
    setPianoRollStart: (startSec) => {
      const state = get()
      const totalSec = sequenceSec(state.bpm, selectLengthBars(state))
      const marginSec = secondsPerGrid(state.bpm, state.gridDivision)
      set({ pianoRollStartSec: clamp(startSec, 0, Math.max(0, totalSec - marginSec)) })
    },

    toggleSnap: () => set((state) => ({ snapEnabled: !state.snapEnabled })),

    /**
     * Change the grid notes land on.
     *
     * Nothing already written moves: the grid says where the next drag lands, and
     * re-gridding a part that was written at a finer one would be a different
     * edit from the one that was asked for.
     */
    setGridDivision: (division) => set({ gridDivision: division }),

    /**
     * Add a note where the user clicked. Time and pitch arrive raw from the grid
     * and are snapped/clamped here, so every note in the store is legal no matter
     * who wrote it.
     *
     * `snap` is whether the click lands on the grid — false while Alt is held, for
     * a note that has to sit between two lines. The pattern's edges still apply:
     * that is a finer grid, not an escape from the pattern.
     */
    addNote: (channelId, startSec, pitch, snap = true) => {
      const { bpm, gridDivision } = get()
      const lengthBars = selectLengthBars(get())
      const start = clampNoteStart(
        snap ? snapSec(startSec, bpm, gridDivision) : startSec,
        defaultNoteSec(bpm, gridDivision),
        bpm,
        lengthBars
      )
      const note: Note = {
        id: crypto.randomUUID(),
        startSec: start,
        lengthSec: clampNoteLength(
          defaultNoteSec(bpm, gridDivision),
          start,
          bpm,
          lengthBars,
          gridDivision
        ),
        pitch,
        velocity: DEFAULT_VELOCITY
      }
      pushUndo(`add:${channelId}`)
      patchNotes(channelId, (notes) => [...notes, note])
      return note
    },

    addNotes: (channelId, notes) => {
      if (notes.length === 0) return
      const { bpm, gridDivision } = get()
      const lengthBars = selectLengthBars(get())
      // Legalised here rather than by the caller, so the rule that every note in
      // the store fits inside its pattern survives a paste that overhangs.
      const legal = notes.map((note) => {
        const startSec = clampNoteStart(note.startSec, note.lengthSec, bpm, lengthBars)
        return {
          ...note,
          startSec,
          lengthSec: clampNoteLength(note.lengthSec, startSec, bpm, lengthBars, gridDivision)
        }
      })
      pushUndo(`add:${channelId}`)
      patchNotes(channelId, (existing) => [...existing, ...legal])
    },

    moveNotes: (channelId, origins, deltaSec, deltaPitch, snap = true) => {
      if (origins.length === 0) return

      const { bpm, gridDivision } = get()
      const lengthBars = selectLengthBars(get())
      const wantedSec = snap ? snapSec(deltaSec, bpm, gridDivision) : deltaSec
      // Pitch is whole semitones however the drag was snapped: a keyboard has no
      // room between its keys.
      const wantedPitch = Math.round(deltaPitch)

      // The group's own extent, which is what the delta has to stay inside for
      // every note to land somewhere legal at once.
      const earliestSec = Math.min(...origins.map((note) => note.startSec))
      const latestSec = Math.max(...origins.map((note) => note.startSec + note.lengthSec))
      const lowestPitch = Math.min(...origins.map((note) => note.pitch))
      const highestPitch = Math.max(...origins.map((note) => note.pitch))

      const moveSec = clamp(wantedSec, -earliestSec, sequenceSec(bpm, lengthBars) - latestSec)
      const movePitch = clamp(wantedPitch, LOWEST_PITCH - lowestPitch, HIGHEST_PITCH - highestPitch)

      // Keyed on which notes are moving, so the whole drag folds into one step
      // and a later drag of the same notes, after a pause, is its own.
      pushUndo(`move:${channelId}:${origins.map((note) => note.id).join(',')}`)
      patchNotes(channelId, (notes) =>
        notes.map((note) => {
          const origin = origins.find((item) => item.id === note.id)
          if (!origin) return note
          return {
            ...note,
            startSec: origin.startSec + moveSec,
            pitch: origin.pitch + movePitch
          }
        })
      )
    },

    resizeNotes: (channelId, origins, deltaSec, snap = true) => {
      if (origins.length === 0) return

      const { bpm, gridDivision } = get()
      const lengthBars = selectLengthBars(get())
      const totalSec = sequenceSec(bpm, lengthBars)
      const minSec = minNoteSec(bpm, gridDivision)
      const wantedSec = snap ? snapSec(deltaSec, bpm, gridDivision) : deltaSec

      // What the group as a whole can take, which is what keeps it rigid: the
      // note that runs out of room or hits the minimum stops the group instead of
      // being clamped on its own and losing the shape of the group.
      const shrinkRoomSec = Math.min(...origins.map((note) => note.lengthSec - minSec))
      const growRoomSec = Math.max(
        ...origins.map((note) => totalSec - (note.startSec + note.lengthSec))
      )
      const resizeSec = clamp(wantedSec, -shrinkRoomSec, growRoomSec)

      pushUndo(`resize:${channelId}:${origins.map((note) => note.id).join(',')}`)
      patchNotes(channelId, (notes) =>
        notes.map((note) => {
          const origin = origins.find((item) => item.id === note.id)
          if (!origin) return note
          return { ...note, lengthSec: origin.lengthSec + resizeSec }
        })
      )
    },

    removeNote: (channelId, noteId) => {
      pushUndo(`remove:${channelId}`)
      patchNotes(channelId, (notes) => notes.filter((note) => note.id !== noteId))
    },

    removeNotes: (channelId, noteIds) => {
      if (noteIds.length === 0) return
      pushUndo(`remove:${channelId}`)
      const doomed = new Set(noteIds)
      patchNotes(channelId, (notes) => notes.filter((note) => !doomed.has(note.id)))
    },

    /**
     * Sound one pitch through a channel, without a note behind it.
     *
     * This is the piano keyboard's own preview: the same voice a note would use,
     * so it goes through the channel's volume, pan, mute and solo and is stopped
     * by the same cut as everything else on the strip.
     */
    previewPitch: async (channelId, pitch) => {
      const state = get()
      const channel = state.channels.find((item) => item.id === channelId)
      const sample = channel && state.samples.find((item) => item.id === channel.sampleId)
      const strip = getStrip(channelId)
      if (!sample || !strip) return

      await resumeAudioContext()
      triggerStrip(strip, sample.buffer, pitch)
    },

    /**
     * How far into the pattern the piano roll's transport has got, in seconds.
     *
     * Answered from the reservation's own history rather than from a start time
     * and the tempo, for the same reason the step cursor is: the tempo and the
     * pattern's length can both change while it runs, and either would put a
     * calculated answer out of step with what is being heard.
     */
    pianoRollPositionAt: (atSec) => {
      const loop = pianoRollLoop
      if (loop === null) return null

      let sounding: ReservedBar | null = null
      for (const bar of loop.recent) {
        if (bar.atSec > atSec) break
        sounding = bar
      }
      // Nothing reserved has started yet, which is only true in the moment
      // between the transport starting and its first bar arriving.
      if (sounding === null) return 0

      return (
        sounding.sequenceStartSec +
        Math.min(sounding.lengthSec, Math.max(0, atSec - sounding.atSec))
      )
    },

    toggleStep: (channelId, step) => {
      pushUndo(`step:${channelId}`)
      patchSteps(channelId, (grid) => withStepToggled(grid, step))
    },

    /**
     * How many steps this channel loops over.
     *
     * Only the count changes: the grid keeps every step it had, so shrinking to
     * 4 and growing back to 16 finds the rest of the bar where it was left.
     */
    setStepCount: (channelId, stepCount) => {
      pushUndo(`step-count:${channelId}`)
      set((state) => ({
        channels: state.channels.map((channel) =>
          channel.id === channelId ? { ...channel, stepCount } : channel
        )
      }))
    },

    setSwing: (channelId, swing) => {
      pushUndo(`swing:${channelId}`)
      set((state) => ({
        channels: state.channels.map((channel) =>
          channel.id === channelId ? { ...channel, swing: clamp(swing, 0, 100) } : channel
        )
      }))
    },

    /**
     * Which step of a channel's loop was sounding at an audio-clock time.
     *
     * Answered from the reservation's own history rather than from a start time
     * and the tempo, because the tempo, the swing and the step count can all
     * change while the loop runs, and every one of them would put a calculated
     * answer out of step with what is being heard.
     */
    soundingStepAt: (channelId, atSec) => {
      const cursor = stepLoop?.channels.get(channelId)
      if (cursor === undefined) return null

      // Falls back to the first reserved step while the loop is still counting
      // in — there is nothing behind the clock to report yet.
      let sounding = cursor.recent[0]?.index ?? cursor.index
      for (const step of cursor.recent) {
        if (step.atSec > atSec) break
        sounding = step.index
      }
      return sounding
    },

    /**
     * Play a channel's sequence from the top.
     *
     * There is one transport, so starting a sequence replaces whatever was
     * running. The whole sequence is scheduled against the audio clock in one go,
     * and the end is reported by the last voice's `onended` — no timers involved.
     */
    playChannelSequence: async (channelId) => {
      const channel = get().channels.find((item) => item.id === channelId)
      // Notes come from the current pattern, which is what makes switching
      // pattern change what plays without touching any channel.
      const notes = selectNotes(get(), channelId)
      if (!channel || notes.length === 0) return
      const sample = get().samples.find((item) => item.id === channel.sampleId)
      const strip = getStrip(channelId)
      if (!sample || !strip) return

      get().stopSequence()
      await resumeAudioContext()

      const startAtSec = getAudioContext().currentTime
      const state = get()
      set({
        playback: {
          mode: 'pattern',
          channelId,
          channelIds: [channelId],
          startedAtSec: startAtSec,
          endsAtSec: startAtSec + sequenceSec(state.bpm, selectLengthBars(state))
        }
      })

      playNoteSequence(strip, sample.buffer, notes, startAtSec, () => {
        // Guard against a stale callback from an earlier run of the same channel.
        set((state) => (state.playback?.channelId === channelId ? { playback: null } : {}))
      })
    },

    /**
     * Play one channel's notes on the piano roll's own transport.
     *
     * Unlike `playChannelSequence`, which hands the whole sequence to the audio
     * clock at once and is done, this reserves the pattern a bar at a time so
     * that edits and tempo changes are picked up while it runs — and keeps
     * reserving when the loop is on, wrapping back to where it started instead of
     * ending.
     *
     * It starts where the cursor is rather than at the top: the first slice is
     * what is left of the bar the cursor is in, and everything after it is whole
     * bars, so the grid keeps its phase.
     *
     * There is one transport, so starting this replaces whatever was running.
     */
    playPianoRoll: async (channelId) => {
      const state = get()
      const channel = state.channels.find((item) => item.id === channelId)
      const notes = selectNotes(state, channelId)
      if (!channel || notes.length === 0) return
      const sample = state.samples.find((item) => item.id === channel.sampleId)
      const strip = getStrip(channelId)
      if (!sample || !strip) return

      get().stopSequence()
      await resumeAudioContext()

      const startAtSec = getAudioContext().currentTime
      const current = get()
      const fromSec = selectPianoRollStartSec(current)
      const totalSec = sequenceSec(current.bpm, selectLengthBars(current))

      pianoRollLoop = {
        frame: 0,
        channelId,
        nextBarAtSec: startAtSec,
        nextSequenceSec: fromSec,
        fromSec,
        reservations: 0,
        recent: []
      }

      set({
        playback: {
          mode: 'piano-roll',
          channelId,
          channelIds: [channelId],
          startedAtSec: startAtSec,
          // One pass from the cursor, which is what the readout counts up to.
          endsAtSec: startAtSec + (totalSec - fromSec)
        }
      })

      reservePianoRoll()
      // The first reservation can give up — a channel whose sample went missing
      // between the click and now — and it clears the loop when it does.
      if (pianoRollLoop !== null) {
        pianoRollLoop.frame = requestAnimationFrame(tickPianoRoll)
      }
    },

    /**
     * Play the whole rack's step grids, looping until stopped.
     *
     * The first pass is reserved here and every later one by the tick above, so
     * unlike a sequence there is no end to report: `playback` clears only when the
     * user stops it. `channelIds` lists the channels that have a step on, which is
     * what `stopSequence` then cuts.
     */
    playSteps: async () => {
      const state = get()
      const armed = state.channels.filter((channel) =>
        hasSteps(selectSteps(state, channel.id), channel.stepCount)
      )

      if (armed.length === 0) {
        set({ error: '步进网格里还没有打开的格子' })
        return
      }

      get().stopSequence()
      await resumeAudioContext()

      const startAtSec = getAudioContext().currentTime
      const { bpm } = get()
      // Channels may loop over different step counts, so the rack is as long as
      // its longest one. This is a readout only — the loop itself never ends.
      const passSec = Math.max(...armed.map((channel) => stepSequenceSec(channel.stepCount, bpm)))

      const channels = new Map<string, ChannelLoop>()
      for (const channel of armed) {
        channels.set(channel.id, { index: 0, atSec: startAtSec, recent: [] })
      }

      set({
        error: null,
        playback: {
          mode: 'steps',
          // The loop is the rack's, not one channel's, so no row may claim it as
          // its own sequence.
          channelId: null,
          channelIds: armed.map((channel) => channel.id),
          startedAtSec: startAtSec,
          endsAtSec: startAtSec + passSec
        }
      })

      stepLoop = { frame: 0, channels }
      reserveSteps()
      stepLoop.frame = requestAnimationFrame(tickStepLoop)
    },

    /**
     * Play the whole arrangement.
     *
     * Every clip is flattened into one timeline per channel first: a clip that is
     * a multiple of the pattern's length repeats it, which is what gives clip
     * length its meaning. Clips of different patterns landing on the same channel
     * end up merged into a single monophonic timeline, so the arrangement never
     * stacks voices on one channel.
     */
    playSong: async () => {
      const { playlistClips, patterns, channels, samples, bpm } = get()
      if (playlistClips.length === 0) return

      const merged = new Map<string, Note[]>()
      let songBars = 0

      for (const clip of playlistClips) {
        const pattern = patterns.find((item) => item.id === clip.patternId)
        if (!pattern) continue
        songBars = Math.max(songBars, clip.startBar + clip.lengthBars)

        const repeats = Math.max(1, Math.round(clip.lengthBars / pattern.lengthBars))
        for (let repeat = 0; repeat < repeats; repeat += 1) {
          const offsetSec = (clip.startBar + repeat * pattern.lengthBars) * secondsPerBar(bpm)
          for (const [channelId, notes] of Object.entries(pattern.notesByChannel)) {
            const timeline = merged.get(channelId) ?? []
            for (const note of notes) {
              timeline.push({ ...note, startSec: note.startSec + offsetSec })
            }
            merged.set(channelId, timeline)
          }
        }
      }

      const scheduled: ScheduledChannel[] = []
      const channelIds: string[] = []
      for (const [channelId, notes] of merged) {
        const channel = channels.find((item) => item.id === channelId)
        const sample = channel && samples.find((item) => item.id === channel.sampleId)
        const strip = getStrip(channelId)
        if (!channel || !sample || !strip) continue
        scheduled.push({
          strip,
          buffer: sample.buffer,
          notes: [...notes].sort((a, b) => a.startSec - b.startSec)
        })
        channelIds.push(channelId)
      }
      if (scheduled.length === 0) {
        // Clips exist but none of them carry a note, so there is no transport to
        // start. Say so rather than leaving the button looking broken.
        set({ error: '时间线上的 Pattern 还没有音符' })
        return
      }

      get().stopSequence()
      await resumeAudioContext()

      const startAtSec = getAudioContext().currentTime
      set({
        playback: {
          mode: 'song',
          channelId: null,
          channelIds,
          startedAtSec: startAtSec,
          endsAtSec: startAtSec + songBars * secondsPerBar(bpm)
        }
      })

      playArrangement(scheduled, startAtSec, () => {
        set((state) => (state.playback?.mode === 'song' ? { playback: null } : {}))
      })
    },

    stopSequence: () => {
      // Ahead of the strips: a step loop that is still reserving steps would put
      // new voices straight back on the strips this is about to cut, and so would
      // the piano roll's transport reserving its next bar.
      const loopedIds = stepLoop === null ? [] : [...stepLoop.channels.keys()]
      stopStepLoop()
      stopPianoRoll()

      const { playback } = get()
      // A channel can have joined the step loop after the transport started, so
      // the loop's own cursors are the only complete list of what is sounding.
      for (const channelId of new Set([...(playback?.channelIds ?? []), ...loopedIds])) {
        const strip = getStrip(channelId)
        // Nulling the voices' onended is what stops the end-of-song callback from
        // firing on a deliberate stop.
        if (strip) stopStrip(strip)
      }
      set({ playback: null })
    },

    /**
     * Switch between editing one pattern and arranging them.
     *
     * Voices already scheduled belong to the mode they were started in, so the
     * transport stops rather than running on under the other view.
     */
    setPlayMode: (mode) => {
      if (mode === get().playMode) return
      get().stopSequence()
      set({ playMode: mode })
    },

    /** Drop a clip of the current pattern onto the timeline. */
    addClip: (startBar) => {
      const state = get()
      const { playlistClips, currentPatternId } = state
      const pattern = selectCurrentPattern(state)
      if (!pattern) return

      const bar = findClipSlot(
        playlistClips,
        startBar,
        pattern.lengthBars,
        selectPlaylistBars(state)
      )
      if (bar === null) {
        set({ error: '时间线放不下更多 Clip 了' })
        return
      }

      const clip: PlaylistClip = {
        id: crypto.randomUUID(),
        patternId: currentPatternId,
        startBar: bar,
        lengthBars: pattern.lengthBars
      }
      pushUndo(`add-clip:${currentPatternId}`)
      set((state) => ({
        playlistClips: [...state.playlistClips, clip],
        selectedClipId: clip.id,
        error: null
      }))
    },

    /** Move a clip, clamped to the free gap it already sits in. */
    moveClip: (clipId, startBar) => {
      pushUndo(`move-clip:${clipId}`)
      set((state) => {
        const playlistBars = selectPlaylistBars(state)
        return {
          playlistClips: state.playlistClips.map((clip) => {
            if (clip.id !== clipId) return clip
            const from = freeFrom(state.playlistClips, clip)
            const to = freeTo(state.playlistClips, clip, playlistBars)
            return {
              ...clip,
              startBar: clamp(Math.round(startBar), from, Math.max(from, to - clip.lengthBars))
            }
          })
        }
      })
    },

    /**
     * Resize a clip, snapping to whole repeats of its pattern.
     *
     * The unit is the clip's own pattern rather than a project-wide length, so a
     * clip of an 8-bar pattern grows in eights and one of a 4-bar pattern in
     * fours — a clip is always a whole number of plays of what is inside it.
     */
    resizeClip: (clipId, lengthBars) => {
      pushUndo(`resize-clip:${clipId}`)
      set((state) => {
        const playlistBars = selectPlaylistBars(state)
        return {
          playlistClips: state.playlistClips.map((clip) => {
            if (clip.id !== clipId) return clip
            const pattern = state.patterns.find((item) => item.id === clip.patternId)
            const unit = pattern?.lengthBars ?? DEFAULT_LENGTH_BARS
            const fits = Math.floor(
              (freeTo(state.playlistClips, clip, playlistBars) - clip.startBar) / unit
            )
            const wanted = Math.round(lengthBars / unit)
            const steps = clamp(wanted, 1, Math.max(1, fits))
            return { ...clip, lengthBars: steps * unit }
          })
        }
      })
    },

    removeClip: (clipId) => {
      pushUndo(`remove-clip:${clipId}`)
      set((state) => ({
        playlistClips: state.playlistClips.filter((clip) => clip.id !== clipId),
        selectedClipId: state.selectedClipId === clipId ? null : state.selectedClipId
      }))
    },

    selectClip: (clipId) => set({ selectedClipId: clipId })
  }
})
