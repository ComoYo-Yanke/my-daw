import { create } from 'zustand'
import {
  createStrip,
  decodeAudioData,
  getAudioContext,
  getStrip,
  playArrangement,
  playNoteSequence,
  releaseAllStrips,
  releaseStrip,
  resumeAudioContext,
  scheduleNoteSequence,
  setMasterGain,
  setStripGain,
  setStripPan,
  stopAllStrips,
  stopStrip,
  toArrayBuffer,
  triggerStrip
} from '../audio/engine'
import type { ScheduledChannel } from '../audio/engine'
import type { ExportVoice } from '../audio/export'
import { isLibraryPath, loadLibrarySample } from '../audio/library'
import { computePeaks } from '../audio/peaks'
import { singleZone, voiceForPitch, type SampleZone } from '../types/sample'
import { parseProjectFile, serializeProject, type ProjectFile } from '../types/project'
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
  lengthBarsForEnd,
  LOWEST_PITCH,
  MAX_BPM,
  MAX_VELOCITY,
  MIN_BPM,
  MIN_VELOCITY,
  minNoteSec,
  secondsPerBar,
  secondsPerGrid,
  sequenceSec,
  snapSec,
  type GridDivision,
  type Note
} from '../types/note'
import { useWindowStore } from './useWindowStore'
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
  /**
   * What the keyboard plays. One entry for an ordinary sample, all of it shifted
   * by the note's own pitch; one entry per recording for a multisampled
   * instrument, where the note picks the nearest — see `voiceForPitch`.
   *
   * Shared by every channel that plays this sample, and never empty.
   */
  zones: SampleZone[]
  /**
   * The zone nearest the sample's own pitch, for the things that want *a*
   * waveform rather than the right one: the thumbnail, and the duration above.
   */
  buffer: AudioBuffer
  peaks: Float32Array
}

/**
 * One audio file found in the user's own sample folder.
 *
 * Only a description — nothing is read or decoded until it is clicked. A folder
 * can hold hundreds of files and the sidebar has to open instantly.
 */
export type UserSample = {
  /** Absolute path on disk. Also what the project stores, so it reopens. */
  path: string
  name: string
  /** The subfolder it came from, or '' for one sitting at the top level. */
  category: string
}

/** Where the chosen folder lives in the app's settings file. */
const USER_SAMPLE_FOLDER_KEY = 'userSampleFolder'

/**
 * What a sample sitting at the top of the folder is filed under.
 *
 * Its own export rather than a literal in the sidebar, because the folder is now
 * drawn in two places — the sidebar and the sample picker — and a category that
 * was named one way in one of them and another way in the other would read as two
 * different categories.
 */
export const ROOT_CATEGORY_LABEL = '（根目录）'

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
 * One row of the song timeline.
 *
 * A track is a lane, and nothing else: it does not own any audio, it only says
 * which clips sit on the same row and which of them are silenced together. What
 * a clip sounds like is still the pattern's business, and what that pattern
 * sounds through is still the channel's — which is why the same pattern can sit
 * on several tracks at once without any of it being copied.
 */
export type PlaylistTrack = {
  id: string
  name: string
  muted: boolean
  soloed: boolean
}

/**
 * One block of a pattern placed on the song timeline.
 *
 * `lengthBars` is the clip's own length, independent of the pattern inside it:
 * a clip shorter than its pattern plays only the pattern's first bars, and one
 * longer loops it until the clip runs out. That is what makes length worth
 * dragging, and it is why the two numbers are stored apart.
 *
 * Clips may overlap — on one track and across tracks. Nothing is spent on
 * keeping them apart, so two clips of one pattern stacked on the same bars is a
 * way of doubling a part rather than a mistake the store refuses.
 */
export type PlaylistClip = {
  id: string
  patternId: string
  /** The lane this clip sits on. */
  trackId: string
  /** Where the clip starts, in bars from the top of the song. */
  startBar: number
  /** How long it runs, in whole bars. At least one. */
  lengthBars: number
}

/**
 * Where a clip was when a drag of it began.
 *
 * A drag says how far it has come, never where it is: the panel reports the
 * distance from these and the store works out the rest, so a gesture that
 * wanders and comes back lands exactly where it started rather than a few
 * hundredths of a bar off after as many roundings.
 */
export type ClipOrigin = {
  id: string
  startBar: number
  trackId: string
}

/**
 * What a drag on the piano roll's empty grid does.
 *
 * A mode rather than a modifier key, because these are the two things a roll is
 * for and neither of them should have to be held down: `draw` writes a note where
 * the press landed, `select` sweeps a rectangle over the notes already there.
 * FL's tool selector, reduced to the two that are actually used.
 */
export type PianoRollTool = 'draw' | 'select'

/**
 * What the transport is running.
 *
 * `steps` is the odd one out. The others have a length and stop themselves when
 * it runs out; the step loop has no end and runs until it is stopped, so it keeps
 * reserving its own next pass instead of reporting a finish.
 *
 * `pattern` is one channel's notes, started by pressing that channel's waveform;
 * `song` is the whole arrangement. `piano-roll` is `pattern` with a clock of its
 * own: it reserves the pattern bar by bar so the tempo and the notes can be read
 * fresh as it goes, and it can wrap round to the top instead of ending. That is
 * also why it needs a mode of its own — its position is not
 * `currentTime - startedAtSec`, it is where the reservation says the clock is.
 */
export type PlaybackMode = 'pattern' | 'song' | 'steps' | 'piano-roll'

/** What the transport is playing right now. */
export type Playback = {
  mode: PlaybackMode
  /** The channel sequence only: the channel whose notes are running. */
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
 * The timeline only ever grows: it never shrinks back to fit its clips, because
 * a stretch of empty song you have scrolled to is somewhere you meant to write.
 * This is the floor it grows from, and what it is reset to.
 */
export const MIN_PLAYLIST_BARS = 32

/** How much one press of 增加小节 adds. */
export const PLAYLIST_GROW_BARS = 8

/** How many tracks a project starts with, and what a file without any gets. */
export const DEFAULT_TRACK_COUNT = 8

/** Base name for the tracks created from the UI. */
export const TRACK_NAME_BASE = 'Track'

/**
 * The grids the timeline offers, in bars.
 *
 * Measured in bars rather than in divisions of a beat, because a bar is what the
 * ruler and the lanes are drawn in. Every entry is a halving of the one before
 * it, down to a 1/16 of a bar — a 1/16 note, which is as fine as a line the lane
 * can actually draw (see `drawnCells`). Finer than that, turn snapping off; that
 * switch is what it is for, and it costs nothing but precision of the hand.
 */
export const PLAYLIST_SNAP_OPTIONS = [1, 0.5, 0.25, 0.125, 0.0625] as const
export type PlaylistSnapDivision = (typeof PLAYLIST_SNAP_OPTIONS)[number]
export const DEFAULT_PLAYLIST_SNAP: PlaylistSnapDivision = 1

/**
 * Shortest a clip can be dragged down to, in bars.
 *
 * One beat, and unrelated to `MIN_LENGTH_BARS` — that one is how short a *pattern*
 * may be, which is a different question. Only reachable with snapping off: at a
 * bar or a beat the snap grid is already the floor.
 */
export const MIN_CLIP_LENGTH_BARS = 0.25

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
  /**
   * Samples a project named but could not be found: sample id -> the path it was
   * saved with.
   *
   * A channel whose sample went missing still gets a row — one missing file must
   * not cost you the whole project — but it points at an id no sample answers to,
   * which is what the row reads as 采样缺失. The path is kept so that saving the
   * project again does not forget where the file was.
   */
  missingSamplePaths: Record<string, string>
  channels: Channel[]
  /** Every pattern in the project. Never empty: a project always has one. */
  patterns: Pattern[]
  /** The pattern the rack and the piano roll are currently editing. */
  currentPatternId: string
  /** Channels with at least one voice sounding, for the row indicators. */
  playingChannelIds: string[]
  isImporting: boolean
  /** The folder the user pointed the library at, or null if they never have. */
  userSampleFolder: string | null
  /** What the last scan of that folder found, in the order it will be drawn. */
  userSamples: UserSample[]
  /** True while the folder is being read, for the browser's own spinner state. */
  isScanningSamples: boolean
  /** Last user-facing failure, cleared by `clearError`. */
  error: string | null
  /** A one-off acknowledgement — "已保存" — cleared by `clearToast`. */
  toast: string | null
  /** The open project's `.mydaw` path, or null if it has never been saved. */
  projectPath: string | null
  /** Whether anything has been edited since the last save. */
  isDirty: boolean

  /** The song arrangement: which pattern plays where, and on which lane. */
  playlistClips: PlaylistClip[]
  /** The lanes those clips sit on. Never empty: a project always has one. */
  playlistTracks: PlaylistTrack[]
  /**
   * How many bars the timeline shows.
   *
   * Only ever grown, by the 增加小节 button or by dragging a clip past the end.
   * What is actually drawn is this or what the clips need, whichever is longer
   * — see `selectPlaylistBars`.
   */
  playlistBars: number
  /**
   * Where the song transport starts from, in bars.
   *
   * Bars rather than seconds, unlike the piano roll's cursor: a bar is what the
   * timeline is measured and drawn in, so moving the tempo has to take the
   * playhead with the music instead of leaving it a fraction of a bar away from
   * where it was aimed. It reaches the audio clock through the same
   * `secondsPerBar` bridge every clip does.
   *
   * A property of the transport rather than of the arrangement: it says where to
   * play from, not what to play. It is saved with the project — a song that always
   * starts from the top is a song you have to aim again on every open — but it is
   * deliberately not in the undo snapshot, the same way `pianoRollStartSec` is
   * not: Ctrl+Z takes back what was done, not where you were looking.
   */
  songStartBar: number
  /** Whether dragging a clip's edge lands on the timeline's grid at all. */
  playlistSnapEnabled: boolean
  /** The grid a dragged clip lands on, in bars. */
  playlistSnapDivision: PlaylistSnapDivision

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
  /** What a drag on empty grid does: write a note, or sweep a rectangle. */
  pianoRollTool: PianoRollTool
  /**
   * The running transport, or null when stopped. The playhead is derived from
   * `startedAtSec` and `AudioContext.currentTime`, never counted up.
   */
  playback: Playback | null
  /**
   * How loud the app itself is, 0 to 1. A linear amplitude, not decibels.
   *
   * The output level of the whole application rather than of anything in it: it
   * is applied after every channel, so it turns the mix down without touching a
   * single channel's volume, pan or mute. 1 is unity, which is why it starts
   * there — an app nobody has asked to turn down is not attenuated.
   *
   * Deliberately outside the project: it says how loud this machine is, not how
   * loud the song is, so it is neither saved nor rendered into an export.
   */
  masterVolume: number
  /** Project tempo, in beats per minute. Everything timed follows it. */
  bpm: number

  setBpm: (bpm: number) => void
  /** Turn the app's own output down, or back up. Not an undo step: no edit. */
  setMasterVolume: (value: number) => void
  /** Take back the last edit, across every kind of edit the store has. */
  undo: () => void
  importSamples: () => Promise<void>
  /**
   * Put one of the built-in samples in the rack as a new channel.
   *
   * The library's own version of `importSamples`: no file dialog, because a
   * library sample is not a file — it is synthesised on the spot from its path.
   */
  addLibrarySample: (path: string) => Promise<void>
  /**
   * Read the remembered sample folder and list what is in it.
   *
   * Meant to be called once, on startup. Nothing happens when no folder has ever
   * been chosen, which is the state the app ships in.
   */
  loadUserSamples: () => Promise<void>
  /** Ask for a sample folder, remember it, and rescan. */
  pickUserSampleFolder: () => Promise<void>
  /** Rescan the folder already chosen, for files added since. */
  refreshUserSamples: () => Promise<void>
  /**
   * Put one of the user's own samples in the rack as a new channel.
   *
   * The folder's version of `addLibrarySample`, and the file's version of it:
   * the bytes are read from disk and decoded, and the channel keeps the real
   * path — which is what makes a project that uses it reopen correctly, the same
   * way an imported sample does.
   */
  addUserSample: (path: string) => Promise<void>
  /**
   * Point a channel at a different sample, and sound it once.
   *
   * Named by path, the way a project file names a sample: a `library://`
   * pseudo-path for a built-in, an absolute path for a file on disk. Nothing new
   * is invented to say where a sample comes from.
   *
   * This is the channel that changes, not one of its rows, so every pattern that
   * uses it changes with it. Nothing else about the channel is touched — not its
   * name, not its level, pan, colour, steps or notes — because changing the sound
   * under a part that has already been written is the whole point of the gesture,
   * and a channel that had to be renamed to match would be a different gesture.
   */
  replaceChannelSample: (channelId: string, path: string) => Promise<void>
  /** The same, with the sample chosen out of a file dialog instead of a list. */
  replaceChannelSampleFromFile: (channelId: string) => Promise<void>
  triggerChannel: (channelId: string) => Promise<void>
  stopAll: () => void
  renameChannel: (channelId: string, name: string) => void
  setVolume: (channelId: string, volume: number) => void
  setPan: (channelId: string, pan: number) => void
  toggleMute: (channelId: string) => void
  toggleSolo: (channelId: string) => void
  duplicateChannel: (channelId: string) => void
  /**
   * Take a channel out of the rack.
   *
   * Its notes and its steps go with it, out of *every* pattern — they are filed
   * under the channel id, so a channel that is gone leaves rows nothing can
   * ever play. The tabs the channel owned in the rack and in the roll go too.
   */
  removeChannel: (channelId: string) => void
  clearError: () => void

  /** Start over with an empty project, after asking about unsaved changes. */
  newProject: () => Promise<void>
  /** Replace everything with the contents of a `.mydaw` file the user picks. */
  openProject: () => Promise<void>
  /** Write over the file the project came from, or ask for one if it has none. */
  saveProject: () => Promise<void>
  /** Always ask for a file, even for a project that already has one. */
  saveProjectAs: () => Promise<void>
  showToast: (message: string) => void
  clearToast: () => void

  selectPattern: (patternId: string) => void
  addPattern: () => void
  /** Copy a pattern, notes and steps and all, under fresh ids. */
  duplicatePattern: (patternId: string) => void
  /**
   * Delete a pattern, the clips that place it, and nothing else.
   *
   * A project always has at least one pattern, so the last one cannot go. What
   * becomes current afterwards is the tab next to the one that went, which is
   * where the eye already is.
   */
  removePattern: (patternId: string) => void
  renamePattern: (patternId: string, name: string) => void
  setPatternLengthBars: (lengthBars: number) => void

  openPianoRoll: (channelId: string) => void
  closePianoRoll: () => void
  toggleLoop: () => void
  /** Move the transport's start, in seconds into the pattern. */
  setPianoRollStart: (startSec: number) => void
  toggleSnap: () => void
  setGridDivision: (division: GridDivision) => void
  setPianoRollTool: (tool: PianoRollTool) => void
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
  /**
   * Change how hard a set of notes is played.
   *
   * Shaped like `moveNotes` and `resizeNotes`: `origins` are the notes as they
   * were when the drag started, and the delta is measured from there rather than
   * accumulated, so a drag that wanders and comes back lands on the velocities
   * it started with.
   *
   * It is deliberately *not* clamped as a group the way those two are. A length
   * is capped by the pattern and a position by the pattern's edges, so when one
   * note runs out of room there is genuinely nothing left for the rest of the
   * group to take and stopping the group is what keeps its shape. Velocity is
   * capped by the note itself, and clamping the group would mean that one note
   * sitting at 127 — which `Ctrl+A` over a part anyone has edited will usually
   * find — freezes every note beneath it, so that "louder by ten" does nothing
   * at all. Each note therefore saturates on its own, and the group flattens
   * only once its loudest member has actually reached the top.
   *
   * Zero is a legal result: velocity 0 is silence, which is how a note is muted
   * without being deleted.
   */
  adjustVelocity: (channelId: string, origins: Note[], deltaVelocity: number) => void
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

  /**
   * Move where the song transport starts.
   *
   * Snapped like every other drag on the timeline, and for the same reason: the
   * playhead is a position on the same grid the clips sit on. `snap` is off when
   * the caller means it — Alt held, or the switch itself off.
   *
   * Clamped here as well as when read, so dragging the playhead past the end
   * parks it at the end rather than storing a position the next tempo change
   * would have to be reasoned about from.
   */
  setSongStart: (bar: number, snap?: boolean) => void
  togglePlaylistSnap: () => void
  /** Change the grid dragged clips land on. Nothing already placed moves. */
  setPlaylistSnapDivision: (division: PlaylistSnapDivision) => void

  /**
   * Drop a clip of the current pattern onto a lane.
   *
   * Returns the clip it made, or null when there was nothing to place — the lane
   * may have been deleted between the click and now, and the panel that asked for
   * it needs the id to select it.
   *
   * `snap` is whether the drop lands on the grid. Off, the clip sits exactly
   * where the pointer was; the floor of zero still applies, because there is no
   * song before the first bar.
   */
  addClip: (trackId: string, startBar: number, snap?: boolean) => PlaylistClip | null
  /**
   * Move clips as one group, by a distance measured from where they were.
   *
   * `origins` is where each clip was when the gesture started, and `origins[0]`
   * is the one under the pointer: the group is positioned by that anchor, so the
   * spacing inside it survives the drag exactly as it was. Passing origins
   * rather than a running delta is what makes a drag that wanders and comes back
   * land where it began.
   *
   * Free placement otherwise: clips may overlap, and lanes have no limit.
   */
  moveClips: (origins: ClipOrigin[], deltaBars: number, deltaTracks: number, snap?: boolean) => void
  /**
   * Drag a clip's right edge. The clip's own length, not a count of plays:
   * shorter than the pattern cuts it off, longer loops it.
   */
  resizeClip: (clipId: string, lengthBars: number, snap?: boolean) => void
  /** Drag a clip's left edge, holding its right end where it is. */
  trimClipStart: (clipId: string, startBar: number, snap?: boolean) => void
  /** Take clips away. One undo step for the lot, however many there are. */
  removeClips: (ids: string[]) => void
  /**
   * Copy clips where they are, and hand back the copies' ids in the order asked.
   *
   * In place, because what this is for is Ctrl+dragging a selection: the copies
   * appear under the pointer and are then dragged where they were going, so a
   * copy made anywhere else would jump. The originals do not move.
   *
   * The undo step is taken here, before the copies exist, and the drag that
   * follows takes one of its own: Ctrl+Z once puts the copies back where they
   * were made, a second time takes them away. That is the order it happened in.
   */
  duplicateClips: (ids: string[]) => string[]

  /** Add an empty lane at the bottom of the timeline. */
  addTrack: () => void
  /**
   * Take a lane away, and the clips on it with it.
   *
   * The clips are not moved to a neighbour: a lane is where you put things, and
   * quietly relocating them would be a different edit from the one asked for.
   * It is one undo step, which is what makes it safe to do without a prompt.
   */
  removeTrack: (trackId: string) => void
  /**
   * Take away every lane with no clips on it, in one step.
   *
   * At least one lane is left, empty or not: nothing can be placed on a timeline
   * that has no lanes, and keeping one costs nothing. Lanes that have clips are
   * not touched — this is the tidy-up after moving things about, not a way to
   * lose work.
   */
  removeEmptyTracks: () => void
  toggleTrackMute: (trackId: string) => void
  toggleTrackSolo: (trackId: string) => void
  /** Make the timeline longer. It never shortens itself to fit the clips. */
  growPlaylist: () => void
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

/**
 * What to number a copy after.
 *
 * "Pattern 3" copies from "Pattern", so the copy is the next free number rather
 * than "Pattern 3 2" — a name that says nothing about what it is. A name with no
 * number on the end, or one that is nothing but a number, is its own base.
 */
function nameBase(name: string): string {
  return name.replace(/\s+\d+$/, '') || name
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

/** A fresh, empty lane. */
function makeTrack(name: string): PlaylistTrack {
  return { id: crypto.randomUUID(), name, muted: false, soloed: false }
}

/**
 * The rack of empty tracks a project starts with.
 *
 * Shared with the project reader rather than duplicated there: a file that
 * records no tracks and a brand new project have to come back looking the same,
 * or "new project" and "open old project" would differ in a way nothing explains.
 */
export function makeDefaultTracks(count: number = DEFAULT_TRACK_COUNT): PlaylistTrack[] {
  return Array.from({ length: count }, (_, index) => makeTrack(`${TRACK_NAME_BASE} ${index + 1}`))
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

/**
 * A per-channel map with one channel's entry dropped.
 *
 * What deleting a channel needs for both `notesByChannel` and `stepsByChannel`:
 * the data is filed under the channel id, so once the channel is gone the entry
 * is a row nothing can ever read, play or draw.
 */
function withoutKey<T>(byChannel: Record<string, T>, channelId: string): Record<string, T> {
  return Object.fromEntries(Object.entries(byChannel).filter(([id]) => id !== channelId))
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
 * The stored length, but never less than what is already on it. Answered this
 * way rather than kept in range on every edit so that a project whose clips run
 * past its recorded length — an older file, or one whose patterns have grown
 * since — opens with those clips still reachable rather than hanging off the end.
 *
 * Rounded up to a whole bar, because a clip may now sit at a fraction of one:
 * a timeline 40.5 bars long would leave the ruler stopping half a bar short of
 * the lanes under it, and `growPlaylist` would write that fraction back into the
 * stored length, where it would stay. The timeline is measured in whole bars.
 */
export function selectPlaylistBars(state: DawState): number {
  const longestPattern = state.patterns.reduce(
    (bars, pattern) => Math.max(bars, pattern.lengthBars),
    MIN_PLAYLIST_BARS
  )
  const furthestClip = state.playlistClips.reduce(
    (bars, clip) => Math.max(bars, clip.startBar + clip.lengthBars),
    0
  )
  return Math.ceil(Math.max(state.playlistBars, longestPattern, furthestClip))
}

/**
 * Where the song transport starts, held inside the timeline.
 *
 * Clamped on the way out rather than kept in range, because what it has to fit
 * inside — the length of the song — can change without the playhead being
 * touched: delete the last clip and the place you had aimed at is off the end.
 * The same shape as `selectPianoRollStartSec`, for the same reason.
 */
export function selectSongStartBar(state: DawState): number {
  return clamp(state.songStartBar, 0, selectPlaylistBars(state))
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
 * A dragged position, put on the timeline's grid.
 *
 * The grid is the whole of the difference: on, the value lands on the nearest
 * multiple of the division; off, it is exactly what was asked for.
 *
 * The *value* is snapped rather than the distance travelled, which is a
 * deliberate departure from the piano roll — see `moveClips`.
 *
 * No floor at zero here. A group of clips is clamped as a group, which is a
 * question about how far the group may travel rather than where one clip may
 * sit; `snapClipBar` is this plus the floor, for the callers that want it.
 */
function snapBar(bar: number, division: number, snap: boolean): number {
  return snap ? Math.round(bar / division) * division : bar
}

/**
 * Where a dragged clip's edge is allowed to land.
 *
 * On the timeline's grid, and never negative either way: there is no song before
 * the first bar.
 */
function snapClipBar(bar: number, division: number, snap: boolean): number {
  return Math.max(0, snapBar(bar, division, snap))
}

/**
 * A clip's length after a drag of its right edge.
 *
 * Snapped like a position, and floored at a beat. The floor is what stops a clip
 * disappearing into nothing: a zero-length clip could never be grabbed again.
 */
function snapClipLength(lengthBars: number, division: number, snap: boolean): number {
  const snapped = snap ? Math.round(lengthBars / division) * division : lengthBars
  return Math.max(MIN_CLIP_LENGTH_BARS, snapped)
}

/**
 * The timeline length that holds a clip ending at `endBar`.
 *
 * Rounded up to a whole `PLAYLIST_GROW_BARS` rather than to the exact bar, so
 * dragging a clip out does not leave the ruler ending a bar past it — the
 * timeline grows in the same steps the 增加小节 button uses.
 */
function barsToHold(endBar: number, current: number): number {
  if (endBar <= current) return current
  return Math.ceil(endBar / PLAYLIST_GROW_BARS) * PLAYLIST_GROW_BARS
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
export function audibleGain(channel: Channel, anySoloed: boolean): number {
  if (channel.muted) return 0
  if (anySoloed && !channel.soloed) return 0
  return channel.volume
}

/** A song flattened onto one timeline: what sounds, and how far it runs. */
export type SongTimeline = {
  /** One entry per channel that has something to play, keyed by channel id. */
  notesByChannel: Map<string, Note[]>
  /** Where the song ends: the furthest edge of any clip that can be heard. */
  bars: number
}

/**
 * Lay the arrangement out as one timeline of notes.
 *
 * Clips are read in bar positions and their patterns unrolled to fill them —
 * played once for a clip no longer than its pattern, repeated for a longer one,
 * with the last repetition cut off at the clip's edge. Two clips of one pattern
 * stacked on a channel arrive as two sets of the same notes, and sound as one
 * part played twice; nothing here tries to keep them apart.
 *
 * Both the transport and the exporter go through this, which is the point: an
 * export that flattened the song its own way would be a second answer to "what
 * does the song sound like", and the two would drift.
 *
 * `bpm` is the tempo to lay it out at, which is the project's unless a caller
 * asks for another one. Everything measured in bars — where a clip starts, how
 * long it is — follows that tempo directly. Note positions inside a pattern do
 * not: they are stored in seconds and so are pinned to the tempo they were
 * written at, and are scaled by the same ratio instead. Render at twice the
 * tempo and every second value halves, which is what keeps the notes where they
 * were drawn rather than sliding towards the front of the clip.
 */
export function selectSongTimeline(state: DawState, bpm: number = state.bpm): SongTimeline {
  const { playlistClips, playlistTracks, patterns } = state

  const barSec = secondsPerBar(bpm)
  const noteSecScale = state.bpm / bpm
  const patternBarSec = secondsPerBar(state.bpm)

  const anySoloed = playlistTracks.some((track) => track.soloed)
  const audibleTracks = new Set(
    playlistTracks
      .filter((track) => !track.muted && (!anySoloed || track.soloed))
      .map((track) => track.id)
  )

  const notesByChannel = new Map<string, Note[]>()
  let bars = 0

  for (const clip of playlistClips) {
    // A clip on a lane that has been deleted, or on a silenced one, is not part
    // of what is heard — and so does not extend the song either.
    if (!audibleTracks.has(clip.trackId)) continue
    const pattern = patterns.find((item) => item.id === clip.patternId)
    if (!pattern) continue

    bars = Math.max(bars, clip.startBar + clip.lengthBars)
    const clipEndBar = clip.startBar + clip.lengthBars

    const plays = Math.ceil(clip.lengthBars / pattern.lengthBars)
    for (let play = 0; play < plays; play += 1) {
      const playStartBar = clip.startBar + play * pattern.lengthBars
      if (playStartBar >= clipEndBar) break

      // In the pattern's own seconds, which is the unit the notes are in.
      const playSec = Math.min(pattern.lengthBars, clipEndBar - playStartBar) * patternBarSec
      const offsetSec = playStartBar * barSec

      for (const [channelId, notes] of Object.entries(pattern.notesByChannel)) {
        const timeline = notesByChannel.get(channelId) ?? []
        for (const note of notes) {
          // Starts past the clip's end, so it was cut away entirely.
          if (note.startSec >= playSec) continue
          timeline.push({
            ...note,
            startSec: note.startSec * noteSecScale + offsetSec,
            lengthSec: Math.min(note.lengthSec, playSec - note.startSec) * noteSecScale
          })
        }
        notesByChannel.set(channelId, timeline)
      }
    }
  }

  return { notesByChannel, bars }
}

/** What one render needs: the channels that sound, and how long it runs. */
export type ExportPlan = {
  voices: ExportVoice[]
  /** End to end, tail included. */
  durationSec: number
}

/**
 * Flatten the song into what the offline render needs.
 *
 * Channel gain is resolved here rather than left to a strip, because the offline
 * graph has no strips to hold it: mute and solo are questions about the whole
 * rack, answered the same way `applyMix` answers them live.
 *
 * A channel with nothing to play is dropped rather than shipped as a silent
 * strip. A channel with no sample, or one whose file went missing, is dropped
 * too — the same reason the transport drops it, which is that there is nothing
 * to sound.
 */
export function selectExportPlan(state: DawState, bpm: number, tailSec: number): ExportPlan {
  const { notesByChannel, bars } = selectSongTimeline(state, bpm)
  const anySoloed = state.channels.some((channel) => channel.soloed)

  const voices: ExportVoice[] = []
  for (const [channelId, notes] of notesByChannel) {
    if (notes.length === 0) continue
    const channel = state.channels.find((item) => item.id === channelId)
    const sample = channel && state.samples.find((item) => item.id === channel.sampleId)
    if (!channel || !sample) continue
    voices.push({
      zones: sample.zones,
      gain: audibleGain(channel, anySoloed),
      pan: channel.pan,
      notes: [...notes].sort((a, b) => a.startSec - b.startSec)
    })
  }

  return { voices, durationSec: bars * secondsPerBar(bpm) + Math.max(0, tailSec) }
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
    playlistTracks: PlaylistTrack[]
    playlistBars: number
  }

  const snapshotOf = (state: DawState): Snapshot => ({
    bpm: state.bpm,
    channels: state.channels,
    patterns: state.patterns,
    currentPatternId: state.currentPatternId,
    playlistClips: state.playlistClips,
    playlistTracks: state.playlistTracks,
    playlistBars: state.playlistBars
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
    // Anything that can be taken back is a change to the project, so the file on
    // disk is now out of date — including the moves that fold into the step
    // already on the stack. Undoing back to the saved state does not clear this
    // again; erring towards "there are unsaved changes" only costs a prompt.
    set({ isDirty: true })

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
   * Forget the history.
   *
   * What loading a project and starting a new one both need: the undo stack holds
   * the previous project, and Ctrl+Z after opening a file must not splice the old
   * one back into the new one a piece at a time.
   */
  const resetHistory = (): void => {
    undoStack.length = 0
    lastUndoKey = null
    lastUndoAtMs = 0
  }

  /** "已保存" and friends. One line, gone in a couple of seconds. */
  const showToast = (message: string): void => set({ toast: message })

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
   * Give a channel id an audio strip.
   *
   * Split out from `makeChannel` because a channel opened from a file already has
   * its id written down: the rack has to be rebuilt under those very ids, or the
   * patterns' notes — which are keyed by channel id — would point at nothing.
   */
  const attachStrip = (id: string): void => {
    createStrip(id, (active) => {
      set((state) => ({
        playingChannelIds: active
          ? [...state.playingChannelIds, id]
          : state.playingChannelIds.filter((playing) => playing !== id)
      }))
    })
  }

  /**
   * Some decoded audio and where it came from, as the pool stores it.
   *
   * Takes the zones rather than one buffer, because a sample may be a whole
   * multisampled instrument. An ordinary file is the one-zone case — the caller
   * wraps its buffer with `singleZone` — so the two are the same shape here.
   */
  const makeSample = (name: string, path: string, zones: SampleZone[]): Sample => {
    // The reference recording: the one nearest the pitch the roll calls 0.
    const reference = voiceForPitch(zones, 0).buffer
    return {
      id: crypto.randomUUID(),
      name,
      path,
      durationSec: reference.duration,
      zones,
      buffer: reference,
      peaks: computePeaks(reference)
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
    attachStrip(id)
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
   * Swap the sample under an existing channel, and play the new one once.
   *
   * The sample the channel was playing stays in the pool. It may well still be
   * another channel's — sharing one sample is legal — and even when it is
   * nobody's, the snapshot `pushUndo` has just taken points back at it, so an
   * undo that could not find it would restore a channel that cannot make a sound.
   *
   * The strip is left alone, which is what makes this safe mid-playback: every
   * note the scheduler reserves looks the sample up again from the channel, so the
   * next note plays the new sound while the ones already sounding finish on the
   * old one. There is no `applyMix` call for the same reason — volume, pan, mute
   * and solo all live on the strip, and not one of them changed.
   *
   * It is heard straight away because that is the only way to browse sounds:
   * clicking through a list works if clicking plays what is clicked.
   */
  const installSampleOnChannel = async (channelId: string, sample: Sample): Promise<void> => {
    pushUndo(`replace-sample:${channelId}`)
    set((state) => ({
      samples: [...state.samples, sample],
      channels: state.channels.map((channel) =>
        channel.id === channelId ? { ...channel, sampleId: sample.id } : channel
      ),
      error: null
    }))

    await resumeAudioContext()
    const strip = getStrip(channelId)
    if (strip) triggerStrip(strip, sample.buffer)
    showToast(`已换成 ${sample.name}`)
  }

  /**
   * Replace one channel's notes in the current pattern, leaving every other
   * channel — and every other pattern — untouched.
   */
  const patchNotes = (
    channelId: string,
    update: (notes: Note[]) => Note[],
    lengthBars?: number
  ): void => {
    const { currentPatternId } = get()
    set((state) => ({
      patterns: state.patterns.map((pattern) =>
        pattern.id === currentPatternId
          ? {
              ...pattern,
              // Written in the same `set` as the notes rather than by a call to
              // `setPatternLengthBars`: a note put past the end and the longer
              // pattern that makes room for it are one edit, and undoing it has
              // to give back both at once.
              lengthBars: lengthBars === undefined ? pattern.lengthBars : lengthBars,
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
          scheduleNoteSequence(strip, sample.zones, [note], atSec)
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
        scheduleNoteSequence(strip, sample.zones, inSlice, loop.nextBarAtSec)
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

  /**
   * Ask before throwing away unsaved work. True means "carry on".
   *
   * A project is a lot of work to lose to a stray click on 新建, and the answer
   * has to come from a dialog outside the window so that it cannot be dismissed
   * by the same click that opened it.
   */
  const confirmDiscardIfDirty = async (): Promise<boolean> => {
    if (!get().isDirty) return true
    return window.api.confirmDiscard()
  }

  /** What a project's samples came back as, ready to be put in the store. */
  type LoadedSamples = {
    samples: Sample[]
    channels: Channel[]
    missingSamplePaths: Record<string, string>
    /** How many of the project's samples could not be read, for the message. */
    missingCount: number
  }

  /**
   * Turn the paths a project recorded into decoded samples.
   *
   * Two kinds of path, two ways back. `library://` ones are built-ins: the
   * synthesised ones are computed here and now, from the same function that made
   * them in the first place, and the ones that ship as audio files are read and
   * decoded. The rest are ordinary files, read by the main process as usual.
   *
   * A path that does not come back — file moved, file deleted, file unreadable —
   * is not a failure of the load. Its channel is still built, pointing at a
   * sample id nothing answers to, which is what makes the row read 采样缺失. One
   * missing kick drum is not a reason to refuse to open a project.
   */
  const loadSamplesFor = async (project: ProjectFile): Promise<LoadedSamples> => {
    const samples: Sample[] = []
    /** Path -> the sample id its channel should point at. Failures never land here. */
    const sampleIdByPath = new Map<string, string>()

    const paths = [...new Set(project.channels.map((channel) => channel.samplePath))].filter(
      (path) => path !== ''
    )

    for (const path of paths.filter(isLibraryPath)) {
      const built = await loadLibrarySample(path)
      // A path that looks like one of ours but is not in the library — or whose
      // files will not come back — is just another missing sample.
      if (built === null) continue
      const sample = makeSample(built.sample.name, path, built.zones)
      samples.push(sample)
      sampleIdByPath.set(path, sample.id)
    }

    const diskPaths = paths.filter((path) => !isLibraryPath(path))
    if (diskPaths.length > 0) {
      const files = await window.api.readSampleFiles(diskPaths)
      for (const file of files) {
        try {
          const buffer = await decodeAudioData(toArrayBuffer(file.data))
          const sample = makeSample(file.name, file.path, singleZone(buffer))
          samples.push(sample)
          sampleIdByPath.set(file.path, sample.id)
        } catch {
          // Read but not decodable — a truncated file, or not audio at all. It
          // is missing as far as the rack is concerned, same as not being there.
        }
      }
    }

    const missingSamplePaths: Record<string, string> = {}
    const channels = project.channels.map((entry) => {
      const { samplePath, ...rest } = entry
      const loadedId = sampleIdByPath.get(samplePath)
      if (loadedId !== undefined) return { ...rest, sampleId: loadedId }

      // The row still needs some id. One that no sample answers to is exactly
      // what "this channel's sample is gone" looks like everywhere else.
      const orphanId = crypto.randomUUID()
      missingSamplePaths[orphanId] = samplePath
      return { ...rest, sampleId: orphanId }
    })

    return {
      samples,
      channels,
      missingSamplePaths,
      missingCount: channels.filter((channel) => channel.sampleId in missingSamplePaths).length
    }
  }

  /**
   * Write the project out.
   *
   * `forceDialog` is the whole difference between 保存 and 另存为: a project that
   * has been saved before goes straight back to its own file, and one that never
   * has — or one the user wants somewhere else — asks for a path first.
   */
  const save = async (forceDialog: boolean): Promise<void> => {
    const state = get()
    try {
      const json = JSON.stringify(serializeProject(state), null, 2)
      const saved = await window.api.saveProject(json, forceDialog ? null : state.projectPath)
      // Nothing was written: the user closed the dialog.
      if (saved === null) return
      // Reading the path back rather than assuming it is what makes 保存 turn
      // into 另存为 for a project that has never had one.
      set({ projectPath: saved.path, isDirty: false, error: null })
      showToast('已保存')
    } catch (cause) {
      set({ error: `保存失败：${errorMessage(cause)}` })
    }
  }

  /**
   * List a folder into the sidebar, or clear the sidebar when there is none.
   *
   * Reading the folder is all this does — nothing is decoded here. A sample
   * becomes audio when it is clicked, so pointing the library at a folder of a
   * few hundred files costs one directory listing rather than a few hundred
   * decodes.
   */
  const applyScan = async (folder: string | null): Promise<void> => {
    if (folder === null) {
      set({ userSampleFolder: null, userSamples: [], isScanningSamples: false })
      return
    }

    set({ isScanningSamples: true })
    try {
      const found = await window.api.scanSampleFolder(folder)
      set({
        userSampleFolder: folder,
        userSamples: found,
        isScanningSamples: false,
        error: null
      })
    } catch (cause) {
      set({ isScanningSamples: false, error: `扫描采样目录失败：${errorMessage(cause)}` })
    }
  }

  // A project always has a pattern to edit and lanes to arrange them on.
  const firstPattern = makePattern(FIRST_PATTERN_NAME)
  const firstTracks = makeDefaultTracks()

  return {
    samples: [],
    missingSamplePaths: {},
    channels: [],
    patterns: [firstPattern],
    currentPatternId: firstPattern.id,
    playingChannelIds: [],
    isImporting: false,
    userSampleFolder: null,
    userSamples: [],
    isScanningSamples: false,
    error: null,
    toast: null,
    projectPath: null,
    isDirty: false,
    playlistClips: [],
    playlistTracks: firstTracks,
    playlistBars: MIN_PLAYLIST_BARS,
    songStartBar: 0,
    // The timeline's own grid settings, separate from the piano roll's: a
    // pattern is written at a 1/16 and an arrangement is laid out in bars, so
    // one switch could not serve both.
    playlistSnapEnabled: true,
    playlistSnapDivision: DEFAULT_PLAYLIST_SNAP,
    pianoRollChannelId: null,
    loopEnabled: false,
    pianoRollStartSec: 0,
    snapEnabled: true,
    gridDivision: DEFAULT_GRID_DIVISION,
    pianoRollTool: 'draw',
    playback: null,
    masterVolume: 1,
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
     * Turn the app's own output down, or back up.
     *
     * Applied to the node rather than kept in the store to be read at the next
     * trigger: it is a level the whole mix passes through, so it takes effect on
     * the voices that are already sounding, and no channel has to be told.
     */
    setMasterVolume: (value) => {
      const next = clamp(value, 0, 1)
      setMasterGain(next)
      set({ masterVolume: next })
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

      // Undoing a channel deletion puts the channel back, but its strip was
      // taken apart when it went, and a row without one is a row that cannot
      // make a sound. Only the missing ones are built: `createStrip` puts a new
      // strip in the map without disconnecting the one it displaces.
      for (const channel of previous.channels) {
        if (getStrip(channel.id) === undefined) attachStrip(channel.id)
      }

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
            const sample = makeSample(file.name, file.path, singleZone(buffer))
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

    /**
     * Put a built-in sample in the rack, and sound it once.
     *
     * The one-shot is the point of clicking a library entry: you are browsing
     * sounds, so you want to hear the one you picked without a second gesture.
     * It goes through the channel's own strip, so volume and pan already apply.
     */
    addLibrarySample: async (path) => {
      const built = await loadLibrarySample(path)
      if (built === null) {
        set({ error: `采样库里没有 ${path}` })
        return
      }

      const sample = makeSample(built.sample.name, path, built.zones)
      const taken = get().channels.length

      pushUndo(`library:${path}`)
      const channel = makeChannel(sample.id, built.sample.name, taken)
      set((state) => ({
        samples: [...state.samples, sample],
        channels: [...state.channels, channel],
        error: null
      }))
      applyMix(get().channels)

      await resumeAudioContext()
      const strip = getStrip(channel.id)
      if (strip) triggerStrip(strip, sample.buffer)
      showToast(`已添加 ${built.sample.name}`)
    },

    loadUserSamples: async () => {
      try {
        const settings = await window.api.readSettings()
        const folder = settings[USER_SAMPLE_FOLDER_KEY]
        // A folder someone has since deleted reads the same as never having
        // chosen one: an empty sidebar rather than a complaint on every startup.
        if (typeof folder !== 'string' || folder === '') {
          await applyScan(null)
          return
        }
        await applyScan(folder)
      } catch (cause) {
        set({ error: `读取设置失败：${errorMessage(cause)}` })
      }
    },

    pickUserSampleFolder: async () => {
      try {
        const folder = await window.api.chooseSampleFolder()
        if (folder === null) return

        // Read first and spread, so this does not become the only setting there
        // is to have. Nothing else is stored yet, and this is what keeps that
        // from being a rule.
        const settings = await window.api.readSettings()
        await window.api.writeSettings({ ...settings, [USER_SAMPLE_FOLDER_KEY]: folder })
        await applyScan(folder)
      } catch (cause) {
        set({ error: `选择采样目录失败：${errorMessage(cause)}` })
      }
    },

    refreshUserSamples: async () => {
      const folder = get().userSampleFolder
      if (folder === null) {
        set({ error: '还没有选择采样目录' })
        return
      }
      await applyScan(folder)
    },

    addUserSample: async (path) => {
      try {
        const files = await window.api.readSampleFiles([path])
        const file = files[0]
        if (file === undefined) {
          set({ error: `打不开 ${path}，文件可能已被移动或删除` })
          return
        }

        const buffer = await decodeAudioData(toArrayBuffer(file.data))
        const name = file.name.replace(/\.[^.]+$/, '')
        const sample = makeSample(file.name, file.path, singleZone(buffer))
        const taken = get().channels.length

        // The path goes into the project as it is, exactly as an imported
        // sample's does — which is what makes reopening work without anything
        // else knowing where the file came from.
        pushUndo(`user-sample:${path}`)
        const channel = makeChannel(sample.id, name, taken)
        set((state) => ({
          samples: [...state.samples, sample],
          channels: [...state.channels, channel],
          error: null
        }))
        applyMix(get().channels)

        await resumeAudioContext()
        const strip = getStrip(channel.id)
        if (strip) triggerStrip(strip, sample.buffer)
        showToast(`已添加 ${name}`)
      } catch (cause) {
        set({ error: `无法解码 ${path}：${errorMessage(cause)}` })
      }
    },

    /**
     * Change which sample a channel plays, where the sample comes from a path.
     *
     * The path is whatever the picker has for the entry that was clicked — a
     * library pseudo-path for a built-in, an absolute path for a file in the
     * user's folder — and the two are told apart by `isLibraryPath`, the same way
     * opening a project tells them apart.
     *
     * Every way out of here is a return rather than a throw: a sample that cannot
     * be found leaves the channel playing what it was playing, and says so. Losing
     * a part because a file moved would be a poor trade for a sound change.
     */
    replaceChannelSample: async (channelId, path) => {
      if (!get().channels.some((channel) => channel.id === channelId)) return

      try {
        let sample: Sample
        if (isLibraryPath(path)) {
          const built = await loadLibrarySample(path)
          if (built === null) {
            set({ error: `采样库里没有 ${path}` })
            return
          }
          sample = makeSample(built.sample.name, path, built.zones)
        } else {
          const files = await window.api.readSampleFiles([path])
          const file = files[0]
          if (file === undefined) {
            set({ error: `打不开 ${path}，文件可能已被移动或删除` })
            return
          }
          const buffer = await decodeAudioData(toArrayBuffer(file.data))
          sample = makeSample(file.name.replace(/\.[^.]+$/, ''), file.path, singleZone(buffer))
        }

        await installSampleOnChannel(channelId, sample)
      } catch (cause) {
        set({ error: `换音色失败：${errorMessage(cause)}` })
      }
    },

    /**
     * The same, with the sample picked out of a file dialog instead of a list.
     *
     * The dialog hands back the bytes it read, so they are decoded as they are
     * rather than being read a second time by path — one less thing that can fail
     * between picking a file and hearing it. A dialog the user cancelled comes
     * back empty, and that is a no-op rather than an error.
     *
     * Only the first file is used. The dialog is the one that imports samples and
     * it takes several because importing several makes several channels; a
     * replacement has one channel to fill, so picking more than one is not a
     * gesture this dialog can honour.
     */
    replaceChannelSampleFromFile: async (channelId) => {
      try {
        const files = await window.api.openSampleFiles()
        const file = files[0]
        if (file === undefined) return

        const buffer = await decodeAudioData(toArrayBuffer(file.data))
        await installSampleOnChannel(
          channelId,
          makeSample(file.name.replace(/\.[^.]+$/, ''), file.path, singleZone(buffer))
        )
      } catch (cause) {
        set({ error: `换音色失败：${errorMessage(cause)}` })
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

    /**
     * Take a channel out of the rack.
     *
     * The strip is taken apart rather than merely silenced: the channel is not
     * coming back, and a strip left wired to the destination would sit there for
     * the rest of the session. Its notes and steps go with it, out of every
     * pattern rather than just the one on screen — they are filed under the
     * channel id, and an id nothing answers to is a row nothing can ever play.
     */
    removeChannel: (channelId) => {
      if (!get().channels.some((channel) => channel.id === channelId)) return

      // Ahead of the strip: a running transport would put its next reserved
      // voice straight back onto the strip this is about to take apart.
      if (get().playback?.channelIds.includes(channelId) === true) get().stopSequence()

      pushUndo(`remove-channel:${channelId}`)
      releaseStrip(channelId)

      set((state) => ({
        channels: state.channels.filter((channel) => channel.id !== channelId),
        playingChannelIds: state.playingChannelIds.filter((playing) => playing !== channelId),
        pianoRollChannelId:
          state.pianoRollChannelId === channelId ? null : state.pianoRollChannelId,
        patterns: state.patterns.map((pattern) => ({
          ...pattern,
          notesByChannel: withoutKey(pattern.notesByChannel, channelId),
          stepsByChannel: withoutKey(pattern.stepsByChannel, channelId)
        }))
      }))
    },

    clearError: () => set({ error: null }),

    showToast,
    clearToast: () => set({ toast: null }),

    /**
     * Start over.
     *
     * Back to the state the app boots in rather than to some "empty" variant of
     * it: one fresh pattern, no channels, no samples, the default tempo. The
     * strips are taken apart rather than left behind, and the history goes with
     * the project it belonged to.
     */
    newProject: async () => {
      if (!(await confirmDiscardIfDirty())) return

      get().stopSequence()
      releaseAllStrips()
      resetHistory()

      const pattern = makePattern(FIRST_PATTERN_NAME)
      set({
        samples: [],
        missingSamplePaths: {},
        channels: [],
        patterns: [pattern],
        currentPatternId: pattern.id,
        playingChannelIds: [],
        playlistClips: [],
        playlistTracks: makeDefaultTracks(),
        playlistBars: MIN_PLAYLIST_BARS,
        songStartBar: 0,
        pianoRollChannelId: null,
        playback: null,
        bpm: DEFAULT_BPM,
        projectPath: null,
        isDirty: false,
        error: null
      })
      showToast('已新建工程')
    },

    /**
     * Open a `.mydaw` file and become it.
     *
     * The order matters. Reading and decoding everything happens first, so a file
     * that turns out to be broken leaves the project you were working on exactly
     * where it was — the transport keeps playing until there is something to
     * replace it with. Only then does the rack get torn down, which is also the
     * only moment the old strips may go: their channels are about to stop
     * existing.
     */
    openProject: async () => {
      if (!(await confirmDiscardIfDirty())) return

      let opened: { path: string; json: string } | null
      try {
        opened = await window.api.openProject()
      } catch (cause) {
        set({ error: `打开失败：${errorMessage(cause)}` })
        return
      }
      if (opened === null) return // The user closed the dialog.

      const parsed = parseProjectFile(opened.json)
      if (!parsed.ok) {
        set({ error: `打开失败：${parsed.error}` })
        return
      }

      let loaded: LoadedSamples
      try {
        loaded = await loadSamplesFor(parsed.project)
      } catch (cause) {
        set({ error: `打开失败：${errorMessage(cause)}` })
        return
      }

      get().stopSequence()
      releaseAllStrips()
      for (const channel of loaded.channels) {
        // Rebuilt under the ids the file recorded, because that is what the
        // patterns' notes and steps are filed under.
        attachStrip(channel.id)
      }
      resetHistory()

      set({
        samples: loaded.samples,
        missingSamplePaths: loaded.missingSamplePaths,
        channels: loaded.channels,
        patterns: parsed.project.patterns,
        currentPatternId: parsed.project.currentPatternId,
        playlistClips: parsed.project.playlistClips,
        playlistTracks: parsed.project.playlistTracks,
        playlistBars: parsed.project.playlistBars,
        songStartBar: parsed.project.songStartBar,
        playingChannelIds: [],
        pianoRollChannelId: null,
        playback: null,
        bpm: parsed.project.bpm,
        projectPath: opened.path,
        isDirty: false,
        error:
          loaded.missingCount === 0
            ? null
            : `${loaded.missingCount} 个通道的采样文件找不到，它们显示为「采样缺失」`
      })
      applyMix(loaded.channels)
      showToast('已打开工程')
    },

    saveProject: () => save(false),
    saveProjectAs: () => save(true),

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

    /**
     * Copy a pattern — its notes and its steps, under fresh ids.
     *
     * Fresh ids for the same reason duplicating a channel makes fresh notes: a
     * copy that shared them would be a second name for the first pattern, and an
     * edit meant for one would land on both.
     *
     * No clips are copied. A pattern is the material and a clip is a placement
     * of it, so the copy arrives unplaced — dropping it on the timeline is the
     * next gesture, not part of this one.
     */
    duplicatePattern: (patternId) => {
      const source = get().patterns.find((pattern) => pattern.id === patternId)
      if (!source) return

      const copy: Pattern = {
        id: crypto.randomUUID(),
        name: nextNumberedName(
          nameBase(source.name),
          get().patterns.map((item) => item.name)
        ),
        lengthBars: source.lengthBars,
        notesByChannel: mapNotes(source.notesByChannel, (notes) =>
          notes.map((note) => ({ ...note, id: crypto.randomUUID() }))
        ),
        // A grid is a fixed-length array of booleans, so a shallow copy of the
        // array is a copy: nothing below it can be edited in place.
        stepsByChannel: Object.fromEntries(
          Object.entries(source.stepsByChannel).map(([channelId, grid]) => [channelId, [...grid]])
        )
      }

      pushUndo('duplicate-pattern')
      set((state) => {
        const patterns = [...state.patterns]
        patterns.splice(patterns.findIndex((pattern) => pattern.id === patternId) + 1, 0, copy)
        return { patterns, error: null }
      })
      get().selectPattern(copy.id)
      showToast(`已复制为 ${copy.name}`)
    },

    /**
     * Delete a pattern, and the clips that placed it.
     *
     * The last pattern cannot go: a project is always editing one, and the roll
     * would have nothing to draw and the transport nothing to play. What becomes
     * current is the tab next to the one that went — the one on its left, which
     * is where the eye already is.
     */
    removePattern: (patternId) => {
      const state = get()
      if (state.patterns.length <= 1) {
        set({ error: '至少要保留一个 Pattern' })
        return
      }
      const at = state.patterns.findIndex((pattern) => pattern.id === patternId)
      if (at === -1) return

      // The pattern being edited is the one going, so whatever is playing was
      // read from it and cannot be un-scheduled.
      if (state.currentPatternId === patternId) get().stopSequence()

      pushUndo(`remove-pattern:${patternId}`)

      const doomed = new Set(
        state.playlistClips.filter((clip) => clip.patternId === patternId).map((clip) => clip.id)
      )

      set((current) => {
        const patterns = current.patterns.filter((pattern) => pattern.id !== patternId)
        return {
          patterns,
          // The neighbour in the list that is left, so index `at` now holds the
          // tab that used to be to the right of the one that went.
          currentPatternId:
            current.currentPatternId === patternId
              ? patterns[Math.min(Math.max(0, at - 1), patterns.length - 1)].id
              : current.currentPatternId,
          playlistClips: current.playlistClips.filter((clip) => !doomed.has(clip.id)),
          error: null
        }
      })
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
      // The roll is a window now, and a roll you cannot see is not open. One
      // way only: closing the window comes back through `closePianoRoll`.
      useWindowStore.getState().openWindow('piano-roll')
    },

    /** Closing the panel stops its transport rather than leaving it playing on. */
    closePianoRoll: () => {
      get().stopSequence()
      set({ pianoRollChannelId: null })
      useWindowStore.getState().closeWindow('piano-roll')
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

    /** Switch what a drag on empty grid does. Not part of the project. */
    setPianoRollTool: (tool) => set({ pianoRollTool: tool }),

    /**
     * Add a note where the user clicked. Time and pitch arrive raw from the grid
     * and are snapped/clamped here, so every note in the store is legal no matter
     * who wrote it.
     *
     * `snap` is whether the click lands on the grid — false while Alt is held, for
     * a note that has to sit between two lines. The pattern's edges still apply:
     * that is a finer grid, not an escape from the pattern.
     *
     * A click past the end of the pattern lengthens it instead of being pulled
     * back inside — the roll draws one length past its end precisely so there is
     * somewhere past the end to click.
     */
    addNote: (channelId, startSec, pitch, snap = true) => {
      const { bpm, gridDivision } = get()
      const lengthBars = selectLengthBars(get())
      const noteSec = defaultNoteSec(bpm, gridDivision)
      // Snapped and then asked to fit, in that order: a press past the pattern's
      // end is a request for a longer pattern, so the length it needs is worked
      // out from where the note wants to be rather than from where the current
      // pattern would allow it. The clamp below only bites at the longest
      // pattern, which is the one length that cannot grow.
      const wantedSec = Math.max(0, snap ? snapSec(startSec, bpm, gridDivision) : startSec)
      const grown = lengthBarsForEnd(bpm, lengthBars, wantedSec + noteSec)
      const start = clampNoteStart(wantedSec, noteSec, bpm, grown)
      const note: Note = {
        id: crypto.randomUUID(),
        startSec: start,
        lengthSec: clampNoteLength(noteSec, start, bpm, grown, gridDivision),
        pitch,
        velocity: DEFAULT_VELOCITY
      }
      pushUndo(`add:${channelId}`)
      patchNotes(channelId, (notes) => [...notes, note], grown)
      return note
    },

    addNotes: (channelId, notes) => {
      if (notes.length === 0) return
      const { bpm, gridDivision } = get()
      const lengthBars = selectLengthBars(get())
      // A paste that overhangs the end extends the pattern, the same as a note
      // drawn there would: the rule that every note in the store fits inside its
      // pattern survives, and what it costs is the pattern rather than the paste.
      const furthestSec = Math.max(...notes.map((note) => note.startSec + note.lengthSec))
      const grown = lengthBarsForEnd(bpm, lengthBars, furthestSec)
      const legal = notes.map((note) => {
        const startSec = clampNoteStart(note.startSec, note.lengthSec, bpm, grown)
        return {
          ...note,
          startSec,
          lengthSec: clampNoteLength(note.lengthSec, startSec, bpm, grown, gridDivision)
        }
      })
      pushUndo(`add:${channelId}`)
      patchNotes(channelId, (existing) => [...existing, ...legal], grown)
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

      // Dragged past the end, the pattern comes with it: the right edge is where
      // the grid stops being drawn, not a wall the notes cannot be pushed
      // through. Only the last length is a wall, and the clamp below still is.
      const grown = lengthBarsForEnd(bpm, lengthBars, latestSec + wantedSec)
      const moveSec = clamp(wantedSec, -earliestSec, sequenceSec(bpm, grown) - latestSec)
      const movePitch = clamp(wantedPitch, LOWEST_PITCH - lowestPitch, HIGHEST_PITCH - highestPitch)

      // Keyed on which notes are moving, so the whole drag folds into one step
      // and a later drag of the same notes, after a pause, is its own.
      pushUndo(`move:${channelId}:${origins.map((note) => note.id).join(',')}`)
      patchNotes(
        channelId,
        (notes) =>
          notes.map((note) => {
            const origin = origins.find((item) => item.id === note.id)
            if (!origin) return note
            return {
              ...note,
              startSec: origin.startSec + moveSec,
              pitch: origin.pitch + movePitch
            }
          }),
        grown
      )
    },

    resizeNotes: (channelId, origins, deltaSec, snap = true) => {
      if (origins.length === 0) return

      const { bpm, gridDivision } = get()
      const lengthBars = selectLengthBars(get())
      const minSec = minNoteSec(bpm, gridDivision)
      const wantedSec = snap ? snapSec(deltaSec, bpm, gridDivision) : deltaSec

      // The same rule the drag follows: grow the pattern first, then work out
      // how much room the group has. Read the other way round, the note that was
      // dragged out past the end would stop at the edge it was dragged over.
      const furthestSec = Math.max(...origins.map((note) => note.startSec + note.lengthSec))
      const grown = lengthBarsForEnd(bpm, lengthBars, furthestSec + wantedSec)
      const totalSec = sequenceSec(bpm, grown)

      // What the group as a whole can take, which is what keeps it rigid: the
      // note that runs out of room or hits the minimum stops the group instead of
      // being clamped on its own and losing the shape of the group.
      const shrinkRoomSec = Math.min(...origins.map((note) => note.lengthSec - minSec))
      const growRoomSec = Math.max(
        ...origins.map((note) => totalSec - (note.startSec + note.lengthSec))
      )
      const resizeSec = clamp(wantedSec, -shrinkRoomSec, growRoomSec)

      pushUndo(`resize:${channelId}:${origins.map((note) => note.id).join(',')}`)
      patchNotes(
        channelId,
        (notes) =>
          notes.map((note) => {
            const origin = origins.find((item) => item.id === note.id)
            if (!origin) return note
            return { ...note, lengthSec: origin.lengthSec + resizeSec }
          }),
        grown
      )
    },

    adjustVelocity: (channelId, origins, deltaVelocity) => {
      if (origins.length === 0) return

      // Whole steps, because MIDI velocity has no fractions and a drag would
      // otherwise write 63.99999 into the project file. Every note moves by the
      // same shift and saturates on its own — see the interface comment.
      const shift = Math.round(deltaVelocity)

      // Keyed on which notes are changing, so one drag folds into one step and a
      // repeat of the key that nudged them is its own.
      pushUndo(`velocity:${channelId}:${origins.map((note) => note.id).join(',')}`)
      patchNotes(channelId, (notes) =>
        notes.map((note) => {
          const origin = origins.find((item) => item.id === note.id)
          if (!origin) return note
          return { ...note, velocity: clamp(origin.velocity + shift, MIN_VELOCITY, MAX_VELOCITY) }
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
     *
     * The zone is picked here rather than by the engine, because this is the one
     * place that sounds a pitch with no note behind it — a multisampled
     * instrument keys off the pitch, so it has to be picked before the call.
     */
    previewPitch: async (channelId, pitch) => {
      const state = get()
      const channel = state.channels.find((item) => item.id === channelId)
      const sample = channel && state.samples.find((item) => item.id === channel.sampleId)
      const strip = getStrip(channelId)
      if (!sample || !strip) return

      await resumeAudioContext()
      const voice = voiceForPitch(sample.zones, pitch)
      triggerStrip(strip, voice.buffer, voice.shift)
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

      playNoteSequence(strip, sample.zones, notes, startAtSec, () => {
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
     * Every audible clip is flattened into one timeline per channel first, and
     * the clip's own length is what shapes it: a clip shorter than its pattern
     * plays only the pattern's first bars, and a longer one loops it until the
     * clip runs out. A note reaching past the clip's end is cut there, so what a
     * clip looks like on the timeline is what it sounds like.
     *
     * Tracks are resolved before any of that: a muted lane contributes nothing,
     * and while any lane is soloed the rest are silent. That is a different
     * question from a channel's own mute and solo, which is answered by the strip
     * — a lane decides *which clips are heard*, a channel decides *how loud*.
     *
     * Clips may overlap, and do: two clips of one pattern stacked on the same
     * channel arrive as two sets of the same notes, which sound as one part
     * played twice. Nothing here tries to keep them apart.
     *
     * The song starts from the playhead rather than from the top. Anything that
     * began before it is dropped rather than picked up mid-note: a sample already
     * under way has nothing to resume from, so a note straddling the start is
     * silent until it would have ended. (The engine can be taught to start a
     * buffer at an offset — `source.start(when, offset)` — and this is where that
     * would go; it is a choice, not a limit.)
     */
    playSong: async () => {
      const state = get()
      const { playlistClips, channels, samples, bpm } = state
      if (playlistClips.length === 0) return

      // Read before the transport is torn down rather than after
      // `resumeAudioContext`, unlike `playPianoRoll`: the notes have to be
      // trimmed before we can tell whether anything is left to play, and that
      // answer decides whether the running transport is disturbed at all — a song
      // that is silent from the playhead must not stop the step loop under it.
      //
      // So this one reading is the whole of where the song starts, and it is the
      // one the trimming is done against. Moving the playhead during the resume
      // below would move the cursor on screen without moving the audio, which is
      // a window of a few milliseconds and is not worth a second trim to close.
      const fromBar = selectSongStartBar(state)
      const barSec = secondsPerBar(bpm)
      const fromSec = fromBar * barSec

      // The same flattening the exporter uses, so what is heard and what is
      // written out cannot come apart.
      const { notesByChannel: merged, bars: songBars } = selectSongTimeline(state)

      // The playhead: everything before it is behind us, and what is left is
      // rebased so that zero is where the transport starts.
      const ahead = new Map<string, Note[]>()
      for (const [channelId, notes] of merged) {
        ahead.set(
          channelId,
          notes
            .filter((note) => note.startSec >= fromSec)
            .map((note) => ({ ...note, startSec: note.startSec - fromSec }))
        )
      }

      const scheduled: ScheduledChannel[] = []
      const channelIds: string[] = []
      for (const [channelId, notes] of ahead) {
        if (notes.length === 0) continue
        const channel = channels.find((item) => item.id === channelId)
        const sample = channel && samples.find((item) => item.id === channel.sampleId)
        const strip = getStrip(channelId)
        if (!channel || !sample || !strip) continue
        scheduled.push({
          strip,
          zones: sample.zones,
          notes: [...notes].sort((a, b) => a.startSec - b.startSec)
        })
        channelIds.push(channelId)
      }
      if (scheduled.length === 0) {
        // Clips exist but none of them carry a note, so there is no transport to
        // start. Say so rather than leaving the button looking broken — and say
        // which of the two reasons it was, because the fix is different.
        const empty = [...merged.values()].every((notes) => notes.length === 0)
        set({ error: empty ? '时间线上的 Pattern 还没有音符' : '播放起点之后没有音符' })
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
          // What is left of the song after the playhead, which is what the
          // progress readout counts up to.
          endsAtSec: startAtSec + Math.max(0, songBars - fromBar) * barSec
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
     * Move where the song transport starts.
     *
     * Not an undo step: the playhead is where you are looking, not something you
     * did to the project, and a snapshot of it would make Ctrl+Z after a nudge
     * take back the edit before the nudge instead. It does not mark the project
     * dirty either, for the same reason — a moved playhead is saved when the next
     * real edit is, and a session that only ever moved the playhead has nothing
     * worth prompting about.
     */
    setSongStart: (bar, snap = true) =>
      set((state) => ({ songStartBar: snapClipBar(bar, state.playlistSnapDivision, snap) })),

    togglePlaylistSnap: () => set((state) => ({ playlistSnapEnabled: !state.playlistSnapEnabled })),

    /**
     * Change the grid dragged clips land on.
     *
     * Nothing already placed moves: the grid says where the next drag lands, and
     * re-gridding a bar that was placed at a finer one would be a different edit
     * from the one that was asked for. Same rule as the piano roll's.
     */
    setPlaylistSnapDivision: (division) => set({ playlistSnapDivision: division }),

    /**
     * Drop a clip of the current pattern onto a lane.
     *
     * Free placement: what is already on those bars is not consulted, and two
     * clips on the same bars are simply two clips. Snapped to the timeline's grid
     * unless the caller says otherwise, because a clip landing between two lines
     * the ruler draws is a clip nothing lines up with.
     */
    addClip: (trackId, startBar, snap = true) => {
      const state = get()
      const pattern = selectCurrentPattern(state)
      // The lane may have been deleted between the click and now.
      if (!pattern || !state.playlistTracks.some((track) => track.id === trackId)) return null

      const bar = snapClipBar(startBar, state.playlistSnapDivision, snap)
      const clip: PlaylistClip = {
        id: crypto.randomUUID(),
        patternId: state.currentPatternId,
        trackId,
        startBar: bar,
        lengthBars: pattern.lengthBars
      }

      pushUndo(`add-clip:${state.currentPatternId}`)
      set((current) => ({
        playlistClips: [...current.playlistClips, clip],
        playlistBars: barsToHold(bar + clip.lengthBars, current.playlistBars),
        error: null
      }))
      return clip
    },

    /**
     * Move clips along the timeline, or onto other lanes.
     *
     * The anchor's new *position* is snapped rather than the distance travelled,
     * which is the opposite of what `moveNotes` does. Snapping the distance keeps
     * a group rigid but leaves a clip that was placed with snapping off off-grid
     * for good, so no drag could ever put it back; snapping the position means
     * every drag lands on the grid, whichever way the clip got where it was.
     * Measuring the anchor's position from the anchor's own origin is what turns
     * that back into a distance for the rest of the group to share.
     *
     * The two clamps are on the group and not on the clips: the leftmost clip is
     * what stops at bar 0, and the outermost lanes are what stop at the two ends
     * of the rack. Clamping each clip on its own would squash the group against
     * the edge instead, which loses the spacing the drag was preserving.
     */
    moveClips: (origins, deltaBars, deltaTracks, snap = true) => {
      if (origins.length === 0) return
      const ids = origins.map((origin) => origin.id)
      pushUndo(`move-clips:${ids.join(',')}`)
      set((state) => {
        const byId = new Map(origins.map((origin) => [origin.id, origin]))
        const tracks = state.playlistTracks
        const laneOf = (origin: ClipOrigin): number =>
          tracks.findIndex((track) => track.id === origin.trackId)

        const lanes = origins.map(laneOf)
        // A lane that is not there — a stale drag — is answered by leaving the
        // whole gesture alone rather than by putting clips on a lane nothing
        // draws. Half a move would be worse than none of one.
        if (lanes.some((lane) => lane < 0)) return state

        const anchor = origins[0]
        // How far the group travels: snapped where the anchor lands, then held
        // back so the leftmost clip of the group stops at bar 0 rather than
        // every clip stopping at bar 0 and the group folding up against it.
        const bars = Math.max(
          snapBar(anchor.startBar + deltaBars, state.playlistSnapDivision, snap) - anchor.startBar,
          -Math.min(...origins.map((origin) => origin.startBar))
        )
        // The same rule down the rack, in whole lanes.
        const step = clamp(
          clamp(lanes[0] + deltaTracks, 0, tracks.length - 1) - lanes[0],
          -Math.min(...lanes),
          tracks.length - 1 - Math.max(...lanes)
        )

        let furthest = 0
        const playlistClips = state.playlistClips.map((clip) => {
          const origin = byId.get(clip.id)
          if (origin === undefined) return clip
          const moved: PlaylistClip = {
            ...clip,
            startBar: origin.startBar + bars,
            trackId: tracks[laneOf(origin) + step]?.id ?? clip.trackId
          }
          furthest = Math.max(furthest, moved.startBar + moved.lengthBars)
          return moved
        })

        return { playlistClips, playlistBars: barsToHold(furthest, state.playlistBars) }
      })
    },

    /**
     * Drag a clip's right edge.
     *
     * The number is the clip's own length in bars, not a count of plays of its
     * pattern: shorter than the pattern cuts the pattern off, longer loops it.
     * At least a beat, however the drag went.
     */
    resizeClip: (clipId, lengthBars, snap = true) => {
      pushUndo(`resize-clip:${clipId}`)
      set((state) => {
        let furthest = 0
        const playlistClips = state.playlistClips.map((clip) => {
          if (clip.id !== clipId) return clip
          const resized: PlaylistClip = {
            ...clip,
            lengthBars: snapClipLength(lengthBars, state.playlistSnapDivision, snap)
          }
          furthest = resized.startBar + resized.lengthBars
          return resized
        })

        return { playlistClips, playlistBars: barsToHold(furthest, state.playlistBars) }
      })
    },

    /**
     * Drag a clip's left edge.
     *
     * The right end is what stays put — it is the edge the eye is not on — so
     * the length becomes whatever is left between the two. The content is not
     * slipped along with it: a clip always plays its pattern from the pattern's
     * first bar, so this moves where the clip begins rather than which part of
     * the pattern it starts from.
     */
    trimClipStart: (clipId, startBar, snap = true) => {
      pushUndo(`trim-clip:${clipId}`)
      set((state) => ({
        playlistClips: state.playlistClips.map((clip) => {
          if (clip.id !== clipId) return clip
          const right = clip.startBar + clip.lengthBars
          // A beat has to survive to the left of the right end, so there is
          // always something left to grab hold of.
          const start = clamp(
            snapClipBar(startBar, state.playlistSnapDivision, snap),
            0,
            right - MIN_CLIP_LENGTH_BARS
          )
          return { ...clip, startBar: start, lengthBars: right - start }
        })
      }))
    },

    removeClips: (ids) => {
      if (ids.length === 0) return
      const doomed = new Set(ids)
      pushUndo(`remove-clips:${ids.join(',')}`)
      set((state) => ({
        playlistClips: state.playlistClips.filter((clip) => !doomed.has(clip.id))
      }))
    },

    duplicateClips: (ids) => {
      const state = get()
      const byId = new Map(state.playlistClips.map((clip) => [clip.id, clip]))
      // Built in the order asked for, so the caller can line the copies up with
      // what it passed in — which is how a drag knows where its copies came from.
      const copies = ids
        .map((id) => byId.get(id))
        .filter((clip): clip is PlaylistClip => clip !== undefined)
        .map((clip) => ({ ...clip, id: crypto.randomUUID() }))
      if (copies.length === 0) return []

      pushUndo(`duplicate-clips:${ids.join(',')}`)
      set((current) => ({ playlistClips: [...current.playlistClips, ...copies], error: null }))
      return copies.map((clip) => clip.id)
    },

    /** Add an empty lane at the bottom of the timeline. */
    addTrack: () => {
      const track = makeTrack(
        nextNumberedName(
          TRACK_NAME_BASE,
          get().playlistTracks.map((item) => item.name)
        )
      )
      pushUndo('add-track')
      set((state) => ({ playlistTracks: [...state.playlistTracks, track] }))
    },

    /**
     * Take a lane away, and the clips on it with it.
     *
     * They are not moved to a neighbour: a lane is where you chose to put things,
     * and quietly relocating them would be a different edit from the one that was
     * asked for. It is one undo step, which is what makes it safe to do without
     * asking first.
     */
    removeTrack: (trackId) => {
      const state = get()
      if (state.playlistTracks.length <= 1) {
        set({ error: '至少要保留一条轨道' })
        return
      }
      if (!state.playlistTracks.some((track) => track.id === trackId)) return

      const doomed = new Set(
        state.playlistClips.filter((clip) => clip.trackId === trackId).map((clip) => clip.id)
      )

      pushUndo(`remove-track:${trackId}`)
      set((current) => ({
        playlistTracks: current.playlistTracks.filter((track) => track.id !== trackId),
        playlistClips: current.playlistClips.filter((clip) => !doomed.has(clip.id)),
        error: null
      }))
    },

    /**
     * Take away every lane with no clips on it.
     *
     * At least one lane survives, empty or not — a timeline with no lanes is a
     * timeline nothing can be dropped on, and a lane of its own costs nothing.
     * Which lane that is: the first one, so the one at the top of the rack is
     * the one that stays and the answer does not depend on what was moved where.
     */
    removeEmptyTracks: () => {
      const state = get()
      const used = new Set(state.playlistClips.map((clip) => clip.trackId))
      const kept = state.playlistTracks.filter((track) => used.has(track.id))
      const next = kept.length === 0 ? [state.playlistTracks[0]] : kept
      // Nothing to do is not an edit, and must not land on the undo stack.
      if (next.length === state.playlistTracks.length) return

      pushUndo('remove-empty-tracks')
      set({ playlistTracks: next, error: null })
    },

    toggleTrackMute: (trackId) => {
      pushUndo(`track-mute:${trackId}`)
      set((state) => ({
        playlistTracks: state.playlistTracks.map((track) =>
          track.id === trackId ? { ...track, muted: !track.muted } : track
        )
      }))
    },

    toggleTrackSolo: (trackId) => {
      pushUndo(`track-solo:${trackId}`)
      set((state) => ({
        playlistTracks: state.playlistTracks.map((track) =>
          track.id === trackId ? { ...track, soloed: !track.soloed } : track
        )
      }))
    },

    /**
     * Make the timeline longer.
     *
     * Measured from what is actually drawn rather than from the stored length, so
     * that pressing it while the clips already run past the stored length still
     * adds its bars on the end instead of doing nothing visible.
     */
    growPlaylist: () =>
      set((state) => ({
        playlistBars: Math.max(state.playlistBars, selectPlaylistBars(state)) + PLAYLIST_GROW_BARS
      }))
  }
})
