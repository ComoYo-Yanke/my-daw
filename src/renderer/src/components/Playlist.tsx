import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { usePlayheadSec } from '../hooks/usePlayheadSec'
import {
  clipCurve,
  PLAYLIST_SNAP_OPTIONS,
  selectPlaylistBars,
  selectSongStartBar,
  useDawStore,
  type ClipOrigin,
  type Pattern,
  type PlaylistClip,
  type PlaylistSnapDivision
} from '../state/useDawStore'
import { selectWindowZ, useWindowStore } from '../state/useWindowStore'
import { clampCurveValue, withMovedPoint, type CurvePoint } from '../types/curve'
import { BEATS_PER_BAR, drawnCells, secondsPerBar } from '../types/note'

/**
 * Clip colours, handed out by the pattern's position in the list.
 *
 * Position rather than a stored colour, so the palette stays a presentation
 * detail and patterns keep their colour for the life of the session.
 */
const CLIP_COLORS = [
  '#6c8cff',
  '#48b57a',
  '#e0a33c',
  '#d96a9c',
  '#5cc8d6',
  '#a97ce0',
  '#e07a5f',
  '#8fbf4a'
]

function colorForPattern(patterns: Pattern[], patternId: string): string {
  const index = patterns.findIndex((pattern) => pattern.id === patternId)
  return CLIP_COLORS[Math.max(0, index) % CLIP_COLORS.length]
}

/**
 * The timeline's geometry, in pixels.
 *
 * Fixed rather than proportional to the container, which is what lets the
 * timeline be longer than the window: a bar is always the same width, so the
 * grid scrolls instead of squeezing. These are handed to the CSS as custom
 * properties, so the drawing and the hit-testing below cannot drift apart.
 *
 * The bar's width is the one of these that moves: it is the zoom, and what is
 * left here is the default it starts at and the range it may be dragged over.
 */
const BAR_WIDTH_PX = 48
const MIN_BAR_PX = 8
const MAX_BAR_PX = 320
const ZOOM_STEP = 1.25
/** The track header column, also pinned to the left edge while scrolling. */
const HEAD_WIDTH_PX = 112
const RULER_HEIGHT_PX = 18
const TRACK_HEIGHT_PX = 34
/** How near the right end a scroll has to get before the timeline grows. */
const GROW_MARGIN_PX = 80

/**
 * How far a press has to travel before it stops being a click.
 *
 * Far enough that a hand shaking on the button does not start a drag, near
 * enough that a drag which means it always does.
 */
const MARQUEE_THRESHOLD_PX = 4

/**
 * Below this width a clip gets no edge handles.
 *
 * The two of them come to 12px, so a clip narrower than this would be nothing
 * but handles and have no body left to grab it by. It can still be dragged, and
 * still deleted from the keyboard or the right button; it just cannot be
 * resized from its edges until it is wide enough to have some.
 */
const MIN_HANDLE_CLIP_PX = 24

/** Past this many notes a clip draws no preview at all. See `ClipNotes`. */
const MAX_CLIP_PREVIEW_NOTES = 240

/**
 * What the snap buttons say.
 *
 * Named in music rather than in decimals: half a bar and a beat are things you
 * can point at on the grid, and "0.25 小节" is a number you have to convert
 * before you know whether it is the line you meant.
 */
const SNAP_LABELS: Record<PlaylistSnapDivision, string> = {
  1: '1 小节',
  0.5: '半小节',
  0.25: '1 拍',
  0.125: '半拍',
  0.0625: '1/4 拍'
}

/**
 * A position on the timeline, as it is written down.
 *
 * Rounded to two places because dragging with snapping off accumulates
 * floating-point dust: 3.9999999999999996 is a number nobody wrote and nobody
 * wants to read back. Two places, not a whole bar — a clip placed at 2.25 bars
 * has to still read as 2.25.
 */
function formatBars(bar: number): string {
  return String(Math.round(bar * 100) / 100)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/** Whether a press has travelled far enough to count as a drag. */
function traveled(startX: number, startY: number, event: PointerEvent): boolean {
  return Math.hypot(event.clientX - startX, event.clientY - startY) >= MARQUEE_THRESHOLD_PX
}

/** Dragging a clip, or a whole selection of them. */
type MoveDrag = {
  kind: 'move'
  /** Where every dragged clip was when the gesture started. The first is the anchor. */
  origins: ClipOrigin[]
  pointerStartX: number
  pointerStartY: number
  /** The lane the press was on, so the drag can be measured in lanes. */
  startTrack: number
  /** Whether this drag copies. Read at the press, acted on at the first movement. */
  copying: boolean
  /** Whether the press has travelled far enough to be a drag at all. */
  moved: boolean
}

/** Dragging one clip's edge. */
type EdgeDrag = {
  kind: 'resize' | 'trim'
  clipId: string
  pointerStartX: number
  startBar: number
  lengthBars: number
}

/**
 * Dragging a selection rectangle out of empty lane.
 *
 * Kept separate from a click on the same empty lane, which is still how a clip
 * is dropped: this becomes a marquee only once the pointer has travelled, and
 * until then it is a press waiting to find out which of the two it is.
 */
type MarqueeDrag = {
  kind: 'marquee'
  /** The lane the press was on, and where on it. */
  trackId: string
  startBar: number
  startTrack: number
  pointerStartX: number
  pointerStartY: number
  /** What an additive marquee starts from. Empty for a replacing one. */
  base: string[]
  moved: boolean
}

/**
 * Dragging the playhead.
 *
 * This one has no origin to measure from: every move sets it outright from where
 * the pointer is, because the whole point of the gesture is to put the playhead
 * where you are pointing at.
 */
type CursorDrag = { kind: 'cursor' }

type Drag = MoveDrag | EdgeDrag | MarqueeDrag | CursorDrag

/** A selection rectangle, in the timeline's own coordinates: bars by lanes. */
type MarqueeRect = { barLo: number; barHi: number; trackLo: number; trackHi: number }

/** Where the content under the pointer has to still be once a zoom is applied. */
type ZoomAnchor = { offsetX: number; bar: number }

/**
 * Whether a clip is caught by a selection rectangle.
 *
 * Bars across and lanes down, not pixels, so the answer is the same whatever the
 * zoom is. Overlapping at all is enough: a rectangle that catches the corner of
 * a clip catches the clip.
 */
function inMarquee(clip: PlaylistClip, lane: number, rect: MarqueeRect): boolean {
  if (lane < rect.trackLo || lane > rect.trackHi) return false
  return clip.startBar < rect.barHi && rect.barLo < clip.startBar + clip.lengthBars
}

/**
 * Where a selection rectangle goes, in pixels, inside the grid's content.
 *
 * The left edge is held at bar 0: the rectangle can be dragged out over the
 * header column, where there are no bars to draw it on, and a box that hangs
 * over the track names would be a box saying something the selection does not.
 */
function marqueeBox(
  rect: MarqueeRect,
  barPx: number
): { left: number; top: number; width: number; height: number } {
  const lo = Math.max(0, rect.barLo)
  const hi = Math.max(lo, rect.barHi)
  return {
    left: lo * barPx,
    top: rect.trackLo * TRACK_HEIGHT_PX,
    width: (hi - lo) * barPx,
    height: (rect.trackHi - rect.trackLo + 1) * TRACK_HEIGHT_PX
  }
}

/**
 * Whether the playlist is the window in front.
 *
 * Its Delete key is not the only one listening — the piano roll has one too, and
 * neither panel can see the other. Acting only when this one is in front halves
 * the problem: a Delete aimed at the piano roll no longer lands on a selection
 * of clips as well. Which is not the whole fix, since a Delete aimed at *this*
 * window still reaches both; that half belongs to the piano roll.
 */
function playlistInFront(): boolean {
  const { windows } = useWindowStore.getState()
  const mine = selectWindowZ(windows, 'playlist')
  return windows.every((win) => win.closed || selectWindowZ(windows, win.id) <= mine)
}

/** One note of a clip's preview, as fractions of the clip's own box. */
type PreviewNote = { id: string; left: number; width: number; top: number }

/**
 * Every note a clip will play, laid out inside it.
 *
 * A clip longer than its pattern plays the pattern over and over, so the preview
 * repeats with it: what is drawn is what will be heard, down to the part of the
 * last repeat that the clip's end cuts off.
 *
 * `top` is a fraction of the clip's height with the pattern's own pitch range
 * stretched across it, so a bass part and a melody both fill the clip they are
 * in rather than both sitting in a two-pixel band. The range is the whole
 * pattern's, across every channel in it — read from one channel, a preview would
 * put the rest of the pattern off the top and the bottom.
 *
 * Past `MAX_CLIP_PREVIEW_NOTES` it gives up and draws nothing: a clip repeating
 * a busy pattern is a solid block of ink at any zoom, which reads as a texture
 * rather than as notes and costs a thousand elements per clip to say so. The
 * `×N` label and the loop lines still say what the clip is doing.
 */
function previewNotes(
  pattern: Pattern,
  lengthBars: number,
  barSec: number,
  plays: number
): PreviewNote[] {
  const notes = Object.values(pattern.notesByChannel).flat()
  if (notes.length === 0 || notes.length * plays > MAX_CLIP_PREVIEW_NOTES) return []

  const pitches = notes.map((note) => note.pitch)
  const hi = Math.max(...pitches)
  const lo = Math.min(...pitches)
  const span = Math.max(1, hi - lo)
  // A pattern is never shorter than a bar, but this divides by it.
  const patternBars = Math.max(pattern.lengthBars, 1)

  const out: PreviewNote[] = []
  for (let play = 0; play < plays; play += 1) {
    const playStart = play * patternBars
    // The last repeat is usually a part of the pattern, which is the clip's end
    // cutting it off rather than anything about the pattern.
    const playBars = Math.min(patternBars, lengthBars - playStart)
    if (playBars <= 0) break

    for (const note of notes) {
      const noteStart = note.startSec / barSec
      if (noteStart >= playBars) continue
      const length = Math.min(note.lengthSec / barSec, playBars - noteStart)
      out.push({
        id: `${play}:${note.id}`,
        left: (playStart + noteStart) / lengthBars,
        // Never narrower than a hairline: a note too short to see would read as
        // a rest where something is playing.
        width: Math.max(length / lengthBars, 0.004),
        top: (hi - note.pitch) / span
      })
    }
  }
  return out
}

type ClipNotesProps = {
  pattern: Pattern
  lengthBars: number
  barSec: number
  /** How many times the clip plays its pattern. */
  plays: number
}

/**
 * The notes of a clip, drawn small.
 *
 * Memoised on the values it draws from rather than on the clip itself: dragging
 * a clip rewrites its object on every pointer move, so a preview that took the
 * clip would redraw sixty times a second to produce the same picture. Handed the
 * pattern — whose identity only changes when it is edited — and the numbers that
 * actually move, React skips the whole subtree until one of those does.
 */
const ClipNotes = memo(function ClipNotes({
  pattern,
  lengthBars,
  barSec,
  plays
}: ClipNotesProps): React.JSX.Element {
  const notes = useMemo(
    () => previewNotes(pattern, lengthBars, barSec, plays),
    [pattern, lengthBars, barSec, plays]
  )

  return (
    <span className="pl-clip__notes">
      {notes.map((note) => (
        <span
          key={note.id}
          className="pl-clip__note"
          style={{
            left: `${note.left * 100}%`,
            width: `${note.width * 100}%`,
            top: `calc(${note.top * 100}% - 1px)`
          }}
        />
      ))}
    </span>
  )
})

type ClipCurveProps = {
  clipId: string
  /** What the clip itself has drawn. Empty when nobody ever has. */
  volumeCurve: CurvePoint[]
  pattern: Pattern
  lengthBars: number
  /** A bar at the project's tempo — what a curve's seconds are measured against. */
  barSec: number
}

/**
 * A clip's volume curve, drawn over it and editable where it is.
 *
 * A sibling of the clip rather than a child of it. `.pl-clip` is
 * `overflow: hidden`, and the default curve always has a node on the first and
 * last instant of the clip — drawn inside, those two would be half cut away and
 * not worth trying to grab. And as a sibling it is outside the clip's own
 * pointer handling, so a press on the curve adds a node instead of starting to
 * drag the clip out from under it.
 *
 * Memoised on the values it draws from, like `ClipNotes` and for the same
 * reason: moving a clip rewrites its object on every pointer move, and
 * `volumeCurve` is one field that comes through the spread untouched, so it
 * keeps its identity across a drag that cannot change the curve. Where it sits
 * is the caller's business — the panel positions a box around it — so a clip
 * being dragged moves this without re-rendering it.
 *
 * The gesture lives here rather than in the panel's own drag machine because
 * this one is measured in one clip's box rather than in bars and lanes, and
 * because a curve drag is not a timeline edit — the two share no coordinate
 * space and no state.
 */
const ClipCurve = memo(function ClipCurve({
  clipId,
  volumeCurve,
  pattern,
  lengthBars,
  barSec
}: ClipCurveProps): React.JSX.Element {
  const setClipCurve = useDawStore((state) => state.setClipCurve)

  // The box, not the drawing inside it: a plain div is stretched by its insets,
  // so the rectangle the pointer is measured against is the clip's own however
  // the `<svg>` inside it ends up being sized.
  const plotRef = useRef<HTMLDivElement>(null)
  /** The node being dragged, and the curve as it was when the gesture began. */
  const dragRef = useRef<{ index: number; base: CurvePoint[] } | null>(null)
  const [dragging, setDragging] = useState(false)

  /** How long the clip is, in seconds: the curve's own horizontal axis. */
  const clipSec = lengthBars * barSec

  /**
   * The curve being drawn.
   *
   * The clip's own if it has one, read off the pattern's velocities if it does
   * not — see `clipCurve`. Recomputed when one of those changes, which during a
   * node drag means on every move: that is the drag working.
   */
  const points = useMemo(
    () => clipCurve(volumeCurve, pattern, barSec, lengthBars),
    [volumeCurve, pattern, barSec, lengthBars]
  )

  /**
   * Where a point on screen is, in the curve's two axes.
   *
   * Measured against the plot box rather than against the clip, so the ends of
   * the curve are the ends of the drawing whatever the zoom is. Clamped in both
   * axes: a node dragged past either end of the clip would be drawn in a place
   * that cannot be reached again.
   */
  const measure = useCallback(
    (event: { clientX: number; clientY: number }): { time: number; value: number } | null => {
      const plot = plotRef.current
      if (plot === null) return null
      const rect = plot.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return null
      return {
        time: clamp(((event.clientX - rect.left) / rect.width) * clipSec, 0, clipSec),
        value: clampCurveValue(1 - (event.clientY - rect.top) / rect.height)
      }
    },
    [clipSec]
  )

  /** A press on the line itself: put a node where the pointer is. */
  const addPoint = (event: React.PointerEvent): void => {
    if (event.button !== 0) return
    event.preventDefault()
    // Without this the lane reads the press as its own and either drops a clip
    // here or starts dragging out a selection.
    event.stopPropagation()
    const at = measure(event)
    if (at === null) return
    // The pointer was on the line, so this lands on it — which is what "click
    // the curve to add a node" has to mean. It is snapped to nothing: a curve is
    // a shape, and there is no grid a shape wants to be on.
    setClipCurve(clipId, [...points, at], `curve-add:${clipId}`)
  }

  const startNodeDrag = (event: React.PointerEvent, index: number): void => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    dragRef.current = { index, base: points }
    setDragging(true)
  }

  const removePoint = (event: React.MouseEvent, index: number): void => {
    event.preventDefault()
    event.stopPropagation()
    setClipCurve(
      clipId,
      points.filter((_, at) => at !== index),
      `curve-remove:${clipId}`
    )
  }

  /**
   * The drag itself, tracked on the window so the pointer may leave the clip.
   *
   * Every move is measured from the curve the gesture started with rather than
   * from the last move, so a drag that wanders and comes back lands on the shape
   * it began with. The node's own index stays valid throughout, because
   * `withMovedPoint` keeps it between its two neighbours — a curve is ordered in
   * time and nothing here reorders it.
   */
  useEffect(() => {
    if (!dragging) return

    const handleMove = (event: PointerEvent): void => {
      const drag = dragRef.current
      if (drag === null) return
      const at = measure(event)
      if (at === null) return
      setClipCurve(
        clipId,
        withMovedPoint(drag.base, drag.index, at.time, at.value, clipSec),
        `curve-drag:${clipId}:${drag.index}`
      )
    }
    const endDrag = (): void => {
      dragRef.current = null
      setDragging(false)
    }

    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', endDrag)
    window.addEventListener('pointercancel', endDrag)
    return () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', endDrag)
      window.removeEventListener('pointercancel', endDrag)
    }
  }, [dragging, clipId, clipSec, measure, setClipCurve])

  /**
   * The polyline, as percentages of the plot box.
   *
   * The viewBox is a plain 0..100 stretched over the clip, and the stroke is
   * asked not to scale with that stretch — so the shape is written in the same
   * numbers the node positions are, at every zoom, and the line stays the same
   * weight however far the timeline is zoomed out.
   */
  const shape = points
    .map((point) => `${axisX(point, clipSec)},${(1 - point.value) * 100}`)
    .join(' ')

  return (
    <div className="pl-curve__body" data-dragging={dragging} ref={plotRef}>
      <svg className="pl-curve__plot" viewBox="0 0 100 100" preserveAspectRatio="none">
        {/* Drawn three times: a dark line to read the bright one against
            whatever colour the clip is, the bright one itself, and a fat
            invisible one — a pixel and a half is not something to aim at. */}
        <polyline className="pl-curve__halo" points={shape} vectorEffect="non-scaling-stroke" />
        <polyline className="pl-curve__line" points={shape} vectorEffect="non-scaling-stroke" />
        <polyline
          className="pl-curve__hit"
          points={shape}
          vectorEffect="non-scaling-stroke"
          onPointerDown={addPoint}
        />
      </svg>
      {points.map((point, index) => (
        <span
          key={index}
          className="pl-curve__node"
          style={{
            left: `${axisX(point, clipSec)}%`,
            top: `${(1 - point.value) * 100}%`
          }}
          title={`${point.time.toFixed(2)} 秒 · 音量 ${Math.round(point.value * 100)}%`}
          onPointerDown={(event) => startNodeDrag(event, index)}
          onContextMenu={(event) => removePoint(event, index)}
        />
      ))}
    </div>
  )
})

/** A curve node's time as a percentage of the clip, for the drawing and the hit test. */
function axisX(point: CurvePoint, clipSec: number): number {
  return clipSec <= 0 ? 0 : (point.time / clipSec) * 100
}

/**
 * The song timeline: patterns placed as clips, one row per track.
 *
 * A clip names a pattern and a span of bars on a track, and holds no notes of
 * its own — placing the same pattern twice places two references to it, so
 * editing the pattern changes both. Clips on one track may overlap, and clips on
 * different tracks play together.
 */
function Playlist(): React.JSX.Element {
  const clips = useDawStore((state) => state.playlistClips)
  const patterns = useDawStore((state) => state.patterns)
  const tracks = useDawStore((state) => state.playlistTracks)
  const currentPatternId = useDawStore((state) => state.currentPatternId)
  // Only song playback drives this cursor; a lone channel sequence has its own.
  const playback = useDawStore((state) => (state.playback?.mode === 'song' ? state.playback : null))

  const addClip = useDawStore((state) => state.addClip)
  const moveClips = useDawStore((state) => state.moveClips)
  const resizeClip = useDawStore((state) => state.resizeClip)
  const trimClipStart = useDawStore((state) => state.trimClipStart)
  const removeClips = useDawStore((state) => state.removeClips)
  const duplicateClips = useDawStore((state) => state.duplicateClips)
  const clearClipCurves = useDawStore((state) => state.clearClipCurves)
  const addTrack = useDawStore((state) => state.addTrack)
  const removeTrack = useDawStore((state) => state.removeTrack)
  const removeEmptyTracks = useDawStore((state) => state.removeEmptyTracks)
  const toggleTrackMute = useDawStore((state) => state.toggleTrackMute)
  const toggleTrackSolo = useDawStore((state) => state.toggleTrackSolo)
  const growPlaylist = useDawStore((state) => state.growPlaylist)
  const playSong = useDawStore((state) => state.playSong)
  const stopSequence = useDawStore((state) => state.stopSequence)

  // The song's own transport start, and the song's own snap settings: neither is
  // shared with the piano roll, which is editing a pattern rather than a song.
  const songStartBar = useDawStore(selectSongStartBar)
  const setSongStart = useDawStore((state) => state.setSongStart)
  const playlistSnapEnabled = useDawStore((state) => state.playlistSnapEnabled)
  const playlistSnapDivision = useDawStore((state) => state.playlistSnapDivision)
  const togglePlaylistSnap = useDawStore((state) => state.togglePlaylistSnap)
  const setPlaylistSnapDivision = useDawStore((state) => state.setPlaylistSnapDivision)

  const bpm = useDawStore((state) => state.bpm)
  // As long as the longest pattern and as far as the furthest clip.
  const playlistBars = useDawStore(selectPlaylistBars)
  const barSec = secondsPerBar(bpm)

  /**
   * How wide a bar is drawn.
   *
   * The panel's own state, not the store's, and not the project's: it says how
   * close you are looking at the timeline, not what the timeline is — the same
   * choice the piano roll's `stepPx` makes, and it resets with the window for
   * the same reason.
   */
  const [barPx, setBarPx] = useState(BAR_WIDTH_PX)

  /**
   * Whether the clips are showing their volume curves.
   *
   * The panel's own state, like the zoom, and for the same reason: it says how
   * you are looking at the timeline rather than what the timeline is. It is
   * deliberately not saved and not an undo step — and because the default curve
   * is derived rather than written into the clip (see `clipCurve`), turning this
   * on does not dirty the project either.
   */
  const [showCurves, setShowCurves] = useState(false)

  /**
   * Which clips are selected.
   *
   * The panel's own state rather than the store's, which is where the piano roll
   * keeps its selection too: nothing outside this window has an opinion about
   * it, and a selection in the store would have to be pruned by every action
   * that can remove a clip — delete, undo, close the project, take a track away
   * — or it would be a list of ids the store would sooner or later be handed
   * back as if they still existed.
   */
  const [selectedClipIds, setSelectedClipIds] = useState<string[]>([])
  /** The rectangle being dragged out, while it is being dragged out. */
  const [marquee, setMarquee] = useState<MarqueeRect | null>(null)

  const gridRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<Drag | null>(null)
  // Mirrors the ref for rendering only: the geometry lives in the ref so that
  // a drag does not re-render on every pointer move.
  const [draggingClipId, setDraggingClipId] = useState<string | null>(null)

  /**
   * Whether the automatic growth has already been asked for at this end.
   *
   * Cleared as soon as a scroll lands away from the end, so one press against
   * the right edge grows once rather than once per scroll event, and carrying on
   * scrolling after that grows again.
   */
  const growAskedRef = useRef(false)

  /**
   * Set while the grid is being scrolled on purpose by the code below.
   *
   * Zooming restores a scroll position, and the growth rule reads scroll
   * position: without this, zooming anywhere near the right end would look
   * exactly like the user reaching it, and the timeline would grow eight bars
   * every time anyone zoomed.
   */
  const suppressGrowRef = useRef(false)

  /** Carried from a zoom to the layout effect that can actually apply it. */
  const zoomAnchorRef = useRef<ZoomAnchor | null>(null)

  const playheadSec = usePlayheadSec(playback)
  const playing = playback !== null
  const currentPattern = patterns.find((pattern) => pattern.id === currentPatternId)

  /**
   * The playhead, in bars.
   *
   * While playing, the transport is running from where the playhead was left, so
   * the clock counts on from there rather than from the top of the song. Stopped,
   * it is simply where it was left — which is also where the next play starts.
   */
  const playheadBar = Math.min(playlistBars, songStartBar + (playing ? playheadSec / barSec : 0))
  /** What the transport has left to run through, from wherever it starts. */
  const songRemainingSec = Math.max(0, playlistBars - songStartBar) * barSec

  /**
   * The selection, with the clips that have gone taken out of it.
   *
   * A selection can lose its clips without this panel being told: undo, the
   * pattern being deleted, a track going out from under it. Derived rather than
   * pruned back into the state — a clip that disappears is not a reason to
   * render twice, and the raw list is only ever read again by a gesture that
   * replaces all of it anyway.
   *
   * The same array comes back when nothing went, so the identity `useMemo` is
   * comparing stays stable and nothing downstream sees a new selection.
   */
  const selection = useMemo(() => {
    if (selectedClipIds.length === 0) return selectedClipIds
    const live = new Set(clips.map((clip) => clip.id))
    const kept = selectedClipIds.filter((id) => live.has(id))
    return kept.length === selectedClipIds.length ? selectedClipIds : kept
  }, [clips, selectedClipIds])

  /**
   * Which of the selected clips have a curve stored, which is what 移除曲线 acts
   * on and what decides whether it is offered at all.
   *
   * Only the stored curve counts. A clip with no curve still *draws* one — read
   * off its notes' velocities, see `clipCurve` — but that one is derived rather
   * than recorded, so there is nothing there to remove. Going by the drawn curve
   * instead would offer the button for clips it could do nothing to.
   *
   * Derived on every render rather than memoised: it is read for its length and
   * handed to a click, never compared or passed down, so its identity is nobody's
   * business — the same reason `selection` above is the one that is memoised.
   */
  const clearableCurveIds = clips
    .filter((clip) => selection.includes(clip.id) && clip.volumeCurve.length > 0)
    .map((clip) => clip.id)

  /**
   * Whether a gesture lands on the grid.
   *
   * Off while Alt is held, which is the piano roll's gesture for the same thing:
   * a modifier you can reach without leaving the drag you are already making.
   */
  const snapping = useCallback(
    (altKey: boolean): boolean => playlistSnapEnabled && !altKey,
    [playlistSnapEnabled]
  )

  /**
   * How far into the grid a point is, past its frame.
   *
   * Everything on the timeline is measured from the grid rather than from the
   * lane it is drawn in: a lane's rect moves with the scroller, so hit-testing
   * against it and then placing something against the grid is two coordinate
   * spaces that differ by exactly the scroll offset.
   */
  const offsetXOf = useCallback((clientX: number): number => {
    const grid = gridRef.current
    if (grid === null) return 0
    // `clientLeft` is the grid's own frame: the timeline starts after it.
    return clientX - grid.getBoundingClientRect().left - grid.clientLeft
  }, [])

  /** Which bar a point is over. May be negative over the header column. */
  const barAt = useCallback(
    (clientX: number): number => {
      const grid = gridRef.current
      if (grid === null) return 0
      return (grid.scrollLeft + offsetXOf(clientX) - HEAD_WIDTH_PX) / barPx
    },
    [barPx, offsetXOf]
  )

  /**
   * Which lane a point is over, clamped to the ones there are.
   *
   * Worked out from the grid's own geometry rather than by asking what element is
   * under the pointer: while a clip is being dragged the thing under the pointer
   * is that clip, which is still in the lane it is leaving rather than the one it
   * is arriving at.
   */
  const trackIndexAt = useCallback(
    (clientY: number): number => {
      const grid = gridRef.current
      if (grid === null) return 0
      // `clientTop` is the grid's own border: the ruler starts after it, not at
      // the box's outer edge.
      const offsetY =
        clientY -
        grid.getBoundingClientRect().top -
        grid.clientTop -
        RULER_HEIGHT_PX +
        grid.scrollTop
      return clamp(Math.floor(offsetY / TRACK_HEIGHT_PX), 0, Math.max(0, tracks.length - 1))
    },
    [tracks.length]
  )

  /** Where a set of clips was, for a drag that is about to move them. */
  const originsOf = useCallback(
    (ids: string[]): ClipOrigin[] => {
      const byId = new Map(clips.map((clip) => [clip.id, clip]))
      return ids
        .map((id) => byId.get(id))
        .filter((clip): clip is PlaylistClip => clip !== undefined)
        .map((clip) => ({ id: clip.id, startBar: clip.startBar, trackId: clip.trackId }))
    },
    [clips]
  )

  const rectBetween = useCallback(
    (drag: MarqueeDrag, event: PointerEvent): MarqueeRect => {
      const bar = barAt(event.clientX)
      const track = trackIndexAt(event.clientY)
      return {
        barLo: Math.min(drag.startBar, bar),
        barHi: Math.max(drag.startBar, bar),
        trackLo: Math.min(drag.startTrack, track),
        trackHi: Math.max(drag.startTrack, track)
      }
    },
    [barAt, trackIndexAt]
  )

  /** Which clips a rectangle catches, on top of whatever was already selected. */
  const selectedIn = useCallback(
    (rect: MarqueeRect, base: string[]): string[] => {
      const lane = new Map(tracks.map((track, index) => [track.id, index]))
      const hits = clips
        .filter((clip) => inMarquee(clip, lane.get(clip.trackId) ?? -1, rect))
        .map((clip) => clip.id)
      return [...new Set([...base, ...hits])]
    },
    [clips, tracks]
  )

  /** Drags are tracked on the window, so the pointer may leave the grid. */
  useEffect(() => {
    const handlePointerMove = (event: PointerEvent): void => {
      const drag = dragRef.current
      if (drag === null) return

      if (drag.kind === 'cursor') {
        setSongStart(barAt(event.clientX), snapping(event.altKey))
        return
      }

      if (drag.kind === 'marquee') {
        if (!drag.moved && !traveled(drag.pointerStartX, drag.pointerStartY, event)) return
        drag.moved = true
        const rect = rectBetween(drag, event)
        setMarquee(rect)
        setSelectedClipIds(selectedIn(rect, drag.base))
        return
      }

      if (drag.kind === 'move') {
        if (!drag.moved) {
          if (!traveled(drag.pointerStartX, drag.pointerStartY, event)) return
          drag.moved = true
          // The copies are made here, on the first real movement, rather than on
          // the press: Ctrl+click without dragging is how one clip is added to a
          // selection, and that must not leave a duplicate behind. They become
          // what this drag is moving, so the originals stay put and no later move
          // has anything left to clone.
          if (drag.copying) {
            const copies = duplicateClips(drag.origins.map((origin) => origin.id))
            if (copies.length > 0) {
              // A copy starts out exactly where its original was, so the origins
              // carry over under the new ids.
              drag.origins = copies.map((id, index) => ({ ...drag.origins[index], id }))
              setSelectedClipIds(copies)
            }
          }
        }

        // Bars rather than pixels, and lanes rather than pixels: the same
        // distance means the same move wherever the pointer is, and the
        // arithmetic does not care how long the timeline has grown to or how
        // tall the rack is.
        moveClips(
          drag.origins,
          (event.clientX - drag.pointerStartX) / barPx,
          trackIndexAt(event.clientY) - drag.startTrack,
          snapping(event.altKey)
        )
        return
      }

      const deltaBars = (event.clientX - drag.pointerStartX) / barPx

      if (drag.kind === 'resize') {
        resizeClip(drag.clipId, drag.lengthBars + deltaBars, snapping(event.altKey))
        return
      }

      trimClipStart(drag.clipId, drag.startBar + deltaBars, snapping(event.altKey))
    }

    /** Forget the gesture and put the rectangle away, whatever it was. */
    const endDrag = (): void => {
      dragRef.current = null
      setDraggingClipId(null)
      setMarquee(null)
    }

    const handlePointerUp = (event: PointerEvent): void => {
      const drag = dragRef.current
      endDrag()
      if (drag === null || drag.kind !== 'marquee' || drag.moved) return

      // Never travelled, so it was a click — and a click on empty lane still
      // drops the current pattern there, the gesture it has always been. At the
      // lane and the bar it was *pressed* on: under the threshold those are the
      // same point, and the press is the one that was aimed.
      addClip(drag.trackId, drag.startBar, snapping(event.altKey))
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    // A cancelled pointer is not a click: the gesture was taken away rather than
    // finished, so it drops nothing on the lane it happened to be over.
    window.addEventListener('pointercancel', endDrag)
    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', endDrag)
    }
  }, [
    addClip,
    barAt,
    barPx,
    duplicateClips,
    moveClips,
    rectBetween,
    resizeClip,
    selectedIn,
    setSongStart,
    snapping,
    trackIndexAt,
    trimClipStart
  ])

  /** Delete removes the selection, the way the piano roll's does for its notes. */
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (selection.length === 0) return
      if (event.key !== 'Delete' && event.key !== 'Backspace') return
      // Never steal the key from the pattern rename box.
      if ((event.target as HTMLElement | null)?.closest('input, textarea') != null) return
      if (!playlistInFront()) return
      event.preventDefault()
      removeClips(selection)
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [selection, removeClips])

  /**
   * Zoom, holding one point of the timeline still.
   *
   * `offsetX` is that point, measured into the grid. Zooming is anchored rather
   * than centred because the thing you are looking at is under the pointer, and
   * a zoom that scrolls it away makes you find it again after every notch.
   */
  const zoomTo = useCallback(
    (next: number, offsetX: number): void => {
      const target = clamp(next, MIN_BAR_PX, MAX_BAR_PX)
      const grid = gridRef.current
      if (grid === null || target === barPx) {
        // Nothing is going to re-render, so nothing may be left waiting to be
        // restored either — a stale anchor would be applied by the next zoom.
        zoomAnchorRef.current = null
        return
      }
      zoomAnchorRef.current = {
        offsetX,
        bar: (grid.scrollLeft + offsetX - HEAD_WIDTH_PX) / barPx
      }
      setBarPx(target)
    },
    [barPx]
  )

  /** The middle of what is on screen — what the buttons keep still. */
  const zoomCentreOffset = (): number => (gridRef.current?.clientWidth ?? 0) / 2

  /**
   * Applies the zoom the state above has just asked for.
   *
   * In a layout effect, not in `zoomTo` itself: the scrollable width only exists
   * once the new bar width has been rendered, and a scroll position written
   * before that is clamped against the size being left behind.
   */
  useLayoutEffect(() => {
    const grid = gridRef.current
    const anchor = zoomAnchorRef.current
    zoomAnchorRef.current = null
    if (grid === null || anchor === null) return

    const before = grid.scrollLeft
    // Set before the write and taken back if the write turned out to be a no-op:
    // a flag left set with no scroll event coming would swallow the user's next
    // scroll instead. Retracting it can happen after the write because scroll
    // events are queued, never delivered in the middle of this.
    suppressGrowRef.current = true
    grid.scrollLeft = anchor.bar * barPx + HEAD_WIDTH_PX - anchor.offsetX
    if (grid.scrollLeft === before) suppressGrowRef.current = false
  }, [barPx])

  /** Ctrl + wheel, the zoom gesture every timeline has. */
  useEffect(() => {
    const grid = gridRef.current
    if (grid === null) return

    const handleWheel = (event: WheelEvent): void => {
      // Without the modifier this is an ordinary scroll, and the browser's own
      // page zoom is not something this panel gets to take over.
      if (!event.ctrlKey) return
      // React's `onWheel` is registered passively and could not stop the browser
      // from acting on the same gesture, so this is a real listener.
      event.preventDefault()
      // Exponential, so a trackpad's many small deltas and a mouse's few large
      // ones come out as the same gesture.
      zoomTo(barPx * Math.exp(-event.deltaY * 0.0025), offsetXOf(event.clientX))
    }

    grid.addEventListener('wheel', handleWheel, { passive: false })
    return () => grid.removeEventListener('wheel', handleWheel)
  }, [barPx, offsetXOf, zoomTo])

  /**
   * Taking hold of a clip.
   *
   * A press on one that is already selected takes the whole selection with it;
   * a press on one that is not makes it the selection first. Either way the
   * pressed clip leads the list, because the first of them is what the group is
   * positioned by.
   */
  const startClipDrag = (
    event: React.PointerEvent,
    clip: PlaylistClip,
    trackIndex: number
  ): void => {
    if (event.button !== 0) return
    // Keeps the lane from treating this as a press on empty space.
    event.stopPropagation()
    // Taken by the clip, so a drag that leaves the window still ends when the
    // button comes up outside it: without this the release would be missed, and
    // the next move over the lane would carry the drag on.
    event.currentTarget.setPointerCapture(event.pointerId)

    const ids = selection.includes(clip.id) ? selection : [clip.id]
    const ordered = [clip.id, ...ids.filter((id) => id !== clip.id)]

    dragRef.current = {
      kind: 'move',
      origins: originsOf(ordered),
      pointerStartX: event.clientX,
      pointerStartY: event.clientY,
      startTrack: trackIndex,
      // Read once, at the press: a Ctrl pressed halfway through a drag would
      // otherwise clone a selection that is already on its way somewhere.
      copying: event.ctrlKey || event.metaKey,
      moved: false
    }
    setSelectedClipIds(ordered)
    setDraggingClipId(clip.id)
  }

  /** Taking hold of one edge of one clip. */
  const startEdgeDrag = (
    event: React.PointerEvent,
    clip: PlaylistClip,
    kind: EdgeDrag['kind']
  ): void => {
    if (event.button !== 0) return
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    setSelectedClipIds([clip.id])
    setDraggingClipId(clip.id)
    dragRef.current = {
      kind,
      clipId: clip.id,
      pointerStartX: event.clientX,
      startBar: clip.startBar,
      lengthBars: clip.lengthBars
    }
  }

  /**
   * Taking hold of the playhead — on the ruler, or on the line itself.
   *
   * Both go through here, and both carry on at the window level: the ruler is an
   * 18px strip and the line is two pixels wide, and a drag that had to stay
   * inside either would be a drag you cannot aim.
   */
  const startCursorDrag = (event: React.PointerEvent): void => {
    if (event.button !== 0) return
    // The lane below would otherwise read this as a press on empty space and
    // drop a clip there, and the window frame would start dragging the window.
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    setSongStart(barAt(event.clientX), snapping(event.altKey))
    dragRef.current = { kind: 'cursor' }
  }

  /**
   * A press on empty lane: the start of a selection rectangle, or a click.
   *
   * Which of the two it is is decided by whether the pointer travels, and
   * nothing happens until it does — except that a replacing press clears the
   * selection at once, so the old one is not still lit while a new one is being
   * dragged out.
   */
  const handleLanePointerDown = (
    event: React.PointerEvent<HTMLDivElement>,
    trackId: string,
    trackIndex: number
  ): void => {
    if (event.button !== 0) return
    // Ctrl on empty lane is the one place it means "add to the selection" rather
    // than "copy": there is nothing here to copy.
    const additive = event.ctrlKey || event.metaKey
    const base = additive ? selection : []
    if (!additive) setSelectedClipIds([])

    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = {
      kind: 'marquee',
      trackId,
      startBar: barAt(event.clientX),
      startTrack: trackIndex,
      pointerStartX: event.clientX,
      pointerStartY: event.clientY,
      base,
      moved: false
    }
  }

  /**
   * Reaching the right end grows the timeline.
   *
   * The one place the timeline's length is asked for rather than derived: the
   * clip arithmetic already extends it to fit whatever is placed, but scrolling
   * into empty space has to be able to ask for more of it.
   */
  const handleGridScroll = (event: React.UIEvent<HTMLDivElement>): void => {
    // A zoom's own scroll is not the user reaching the end.
    if (suppressGrowRef.current) {
      suppressGrowRef.current = false
      return
    }

    const element = event.currentTarget
    if (element.scrollLeft + element.clientWidth < element.scrollWidth - GROW_MARGIN_PX) {
      growAskedRef.current = false
      return
    }
    if (growAskedRef.current) return
    growAskedRef.current = true
    growPlaylist()
  }

  /**
   * How many cells to a bar the lane's own fine lines are drawn at.
   *
   * The snap division decides, except where the zoom cannot show it: the cells
   * are a fraction of a bar in the same way the divisions are, so this is the
   * reciprocal of the division, and `drawnCells` walks back from there until the
   * lines have room. Snapping keeps to the division either way.
   *
   * Only drawn when it is finer than a beat. At a beat or wider it would land
   * exactly on the beat or bar line and paint over that line's colour — saying
   * nothing, and costing the line it covered its meaning.
   */
  const cellBars = drawnCells(1 / playlistSnapDivision, barPx)
  const drawingCells = cellBars > BEATS_PER_BAR

  const gridStyle = {
    '--pl-bar-w': `${barPx}px`,
    '--pl-beat-w': `${barPx / BEATS_PER_BAR}px`,
    '--pl-group-w': `${barPx * BEATS_PER_BAR}px`,
    // A colour rather than a width, so the lane's four layers are declared once
    // and this is the one thing that switches the finest of them off.
    '--pl-cell-w': `${barPx / cellBars}px`,
    '--pl-cell-color': drawingCells ? '#202029' : 'transparent',
    '--pl-head-w': `${HEAD_WIDTH_PX}px`,
    '--pl-ruler-h': `${RULER_HEIGHT_PX}px`,
    '--pl-track-h': `${TRACK_HEIGHT_PX}px`,
    '--pl-lane-w': `${playlistBars * barPx}px`,
    '--pl-tracks-h': `${tracks.length * TRACK_HEIGHT_PX}px`
  } as React.CSSProperties

  const box = marquee === null ? null : marqueeBox(marquee, barPx)

  return (
    <section className="playlist" aria-label="播放列表">
      {/* No title of its own: the window frame above this one has it. */}
      <header className="pl__header">
        <button
          type="button"
          className="pl__play"
          onClick={() => {
            if (playback !== null) {
              stopSequence()
            } else {
              void playSong()
            }
          }}
          disabled={clips.length === 0}
          aria-pressed={playback !== null}
          title={clips.length === 0 ? '先在时间线上放一个 Clip' : '从播放线开始播放 / 暂停'}
        >
          {playback !== null ? '⏸ 暂停' : '▶ 播放'}
        </button>

        <button
          type="button"
          className="pl__add"
          onClick={growPlaylist}
          title="在时间线末尾再加 8 小节"
        >
          ＋ 增加小节
        </button>
        <button type="button" className="pl__add" onClick={addTrack} title="在下面再加一条轨道">
          ＋ 增加轨道
        </button>
        <button
          type="button"
          className="pl__add"
          onClick={removeEmptyTracks}
          disabled={tracks.length === 1}
          title="把所有没有 Clip 的轨道一次删掉（至少留一条）"
        >
          清理空轨
        </button>
        <button
          type="button"
          className="pl__add"
          aria-pressed={showCurves}
          onClick={() => setShowCurves((on) => !on)}
          title={
            showCurves
              ? '收起音量曲线，片段回到只显示音符缩略图'
              : '在每个片段上叠一条音量曲线：点曲线加点、拖节点改时间和音量、右键节点删除'
          }
        >
          显示曲线
        </button>
        {/* Next to the switch, because it is about the same thing: that one
            decides whether curves are drawn, this one takes them off the
            selection. Off when there is nothing to take off, and the title says
            which of the two reasons that is — "you have not selected anything"
            and "what you selected has nothing on it" want different answers. */}
        <button
          type="button"
          className="pl__add"
          onClick={() => clearClipCurves(clearableCurveIds)}
          disabled={clearableCurveIds.length === 0}
          title={
            selection.length === 0
              ? '先选中片段：在空白处拖一个框，或者点一个片段'
              : clearableCurveIds.length === 0
                ? '选中的片段都没有画过曲线，没有东西可以移除'
                : `移除选中的 ${clearableCurveIds.length} 个片段上的曲线，它们回到自己的音量（可 Ctrl+Z 撤销）`
          }
        >
          移除曲线
        </button>

        <span className="pl__group">
          <span className="pl__group-label">吸附</span>
          <button
            type="button"
            className="pl__add"
            aria-pressed={playlistSnapEnabled}
            onClick={togglePlaylistSnap}
            title={
              playlistSnapEnabled
                ? '关掉吸附：片段落在哪儿就是哪儿（拖动时按住 Alt 也能临时关掉）'
                : '打开吸附：片段落在小节线上'
            }
          >
            {playlistSnapEnabled ? '开' : '关'}
          </button>
          {PLAYLIST_SNAP_OPTIONS.map((option) => (
            <button
              key={option}
              type="button"
              className="pl__add"
              aria-pressed={playlistSnapDivision === option}
              disabled={!playlistSnapEnabled}
              onClick={() => setPlaylistSnapDivision(option)}
              title={`吸附到 ${SNAP_LABELS[option]}`}
            >
              {SNAP_LABELS[option]}
            </button>
          ))}
        </span>

        <span className="pl__group">
          <span className="pl__group-label">缩放</span>
          <button
            type="button"
            className="pl__add"
            onClick={() => zoomTo(barPx / ZOOM_STEP, zoomCentreOffset())}
            disabled={barPx <= MIN_BAR_PX}
            title="缩小（也可以按住 Ctrl 滚滚轮）"
            aria-label="缩小"
          >
            −
          </button>
          <span className="pl__zoom" title={`一个小节 ${Math.round(barPx)} 像素`}>
            {Math.round((barPx / BAR_WIDTH_PX) * 100)}%
          </span>
          <button
            type="button"
            className="pl__add"
            onClick={() => zoomTo(barPx * ZOOM_STEP, zoomCentreOffset())}
            disabled={barPx >= MAX_BAR_PX}
            title="放大（也可以按住 Ctrl 滚滚轮）"
            aria-label="放大"
          >
            ＋
          </button>
          <button
            type="button"
            className="pl__add"
            onClick={() => zoomTo(BAR_WIDTH_PX, zoomCentreOffset())}
            disabled={barPx === BAR_WIDTH_PX}
            title={`回到默认宽度（${BAR_WIDTH_PX} 像素一个小节）`}
          >
            复位
          </button>
        </span>

        <span className="pl__counts">
          {tracks.length} 轨 · {playlistBars} 小节 · 选中 {selection.length}
        </span>
        <span className="pl__position">
          {formatBars(playheadBar)} 小节 · {playheadSec.toFixed(2)} / {songRemainingSec.toFixed(2)}{' '}
          s
        </span>
        <span className="pl__hint">
          空格播放 · 空白处点击放入当前 Pattern（{currentPattern?.name ?? '—'}）·
          拖动移动（可跨轨）· 拖右边缘改长度 · 拖左边缘改起点 · 拖空白框选 · Ctrl 拖动复制 ·
          拖标尺或播放线设起点 · Delete 删除
          {showCurves && ' · 曲线：点线加点 · 拖节点改值 · 右键节点删除'}
        </span>
      </header>

      <div className="pl__grid" ref={gridRef} style={gridStyle} onScroll={handleGridScroll}>
        {/* The ruler is offset by the header column so bar 1 starts where the
            lanes do, and pinned to the top so it stays readable while scrolling
            down a stack of tracks. It is also the widest thing to aim at when
            placing the playhead, which is why pressing it does that. */}
        <div className="pl__ruler" onPointerDown={startCursorDrag}>
          {Array.from({ length: playlistBars }, (_, index) => (
            <span
              key={index}
              className="pl__ruler-bar"
              data-group={(index + 1) % BEATS_PER_BAR === 1}
            >
              {index + 1}
            </span>
          ))}
          {/* The start, marked in the ruler as well as down the lanes: the
              playhead scrolls out of sight sideways, and this is the handle that
              does not have to be chased. */}
          <span
            className="pl__ruler-cursor"
            data-playing={playing}
            style={{ left: `calc(var(--pl-head-w) + ${playheadBar * barPx}px)` }}
          />
        </div>

        {tracks.map((track, trackIndex) => (
          <div key={track.id} className="pl-track" data-muted={track.muted}>
            <div className="pl-track__head">
              <span className="pl-track__name" title={track.name}>
                {track.name}
              </span>
              <button
                type="button"
                className="pl-track__toggle pl-track__toggle--mute"
                aria-pressed={track.muted}
                onClick={() => toggleTrackMute(track.id)}
                title="静音该轨（下次播放生效）"
              >
                M
              </button>
              <button
                type="button"
                className="pl-track__toggle pl-track__toggle--solo"
                aria-pressed={track.soloed}
                onClick={() => toggleTrackSolo(track.id)}
                title="独奏该轨（下次播放生效）"
              >
                S
              </button>
              <button
                type="button"
                className="pl-track__remove"
                onClick={() => removeTrack(track.id)}
                title="删除该轨（连它上面的 Clip 一起，可 Ctrl+Z 撤销）"
                aria-label={`删除 ${track.name}`}
              >
                ×
              </button>
            </div>

            <div
              className="pl-lane"
              data-track-id={track.id}
              data-curves={showCurves}
              onPointerDown={(event) => handleLanePointerDown(event, track.id, trackIndex)}
            >
              {clips
                .filter((clip) => clip.trackId === track.id)
                .map((clip) => {
                  const pattern = patterns.find((item) => item.id === clip.patternId)
                  const patternBars = pattern?.lengthBars ?? 1
                  // How many times the clip plays its pattern: a clip longer than
                  // its pattern loops it, a shorter one cuts it off. The epsilon
                  // keeps a clip of exactly two patterns from reading as three —
                  // `lengthBars / patternBars` is 2.0000000000000004 for some
                  // pairs of lengths, and the extra play would be an empty one.
                  const plays = Math.max(1, Math.ceil(clip.lengthBars / patternBars - 1e-9))
                  const wide = clip.lengthBars * barPx >= MIN_HANDLE_CLIP_PX
                  return (
                    // The curve is a sibling of the clip rather than a child of
                    // it — see `ClipCurve` — so the two travel together in one
                    // fragment keyed by the clip they both belong to.
                    <Fragment key={clip.id}>
                      <div
                        className="pl-clip"
                        data-selected={selection.includes(clip.id)}
                        data-dragging={clip.id === draggingClipId}
                        style={{
                          left: `${clip.startBar * barPx}px`,
                          width: `${clip.lengthBars * barPx}px`,
                          background: colorForPattern(patterns, clip.patternId)
                        }}
                        title={`${pattern?.name ?? '未知 Pattern'} · 第 ${formatBars(clip.startBar + 1)} 小节起 · ${formatBars(clip.lengthBars)} 小节${plays > 1 ? `（循环 ${plays} 次）` : ''}`}
                        onPointerDown={(event) => startClipDrag(event, clip, trackIndex)}
                        onContextMenu={(event) => {
                          event.preventDefault()
                          // A drag in flight: on macOS a Ctrl+press is how a
                          // secondary click is made at all, and deleting the clip
                          // being copied is not what that gesture meant.
                          if (dragRef.current !== null) return
                          // Inside the selection, the whole selection goes; outside
                          // it, just the one that was pointed at.
                          removeClips(selection.includes(clip.id) ? selection : [clip.id])
                        }}
                      >
                        {pattern !== undefined && (
                          <ClipNotes
                            pattern={pattern}
                            lengthBars={clip.lengthBars}
                            barSec={barSec}
                            plays={plays}
                          />
                        )}
                        {/* One line per loop of the pattern inside the clip, where
                          the pattern starts over. There is one fewer of them
                          than there are plays: the last would sit on the clip's
                          own right edge and say nothing. */}
                        {Array.from({ length: plays - 1 }, (_, loop) => (
                          <span
                            key={loop}
                            className="pl-clip__loop"
                            style={{
                              left: `${(((loop + 1) * patternBars) / clip.lengthBars) * 100}%`
                            }}
                          />
                        ))}
                        {wide && (
                          <span
                            className="pl-clip__handle pl-clip__handle--left"
                            title="拖动改变起点（右端不动）"
                            onPointerDown={(event) => startEdgeDrag(event, clip, 'trim')}
                          />
                        )}
                        <span className="pl-clip__label">
                          {pattern?.name ?? '未知'}
                          {plays > 1 ? ` ×${plays}` : ''}
                        </span>
                        {wide && (
                          <span
                            className="pl-clip__handle pl-clip__handle--right"
                            title="拖动改变长度（拖短裁切、拖长循环）"
                            onPointerDown={(event) => startEdgeDrag(event, clip, 'resize')}
                          />
                        )}
                      </div>
                      {/* The box the curve lives in, positioned by the clip and
                        not by the curve: dragging the clip then moves this
                        without the curve inside it re-rendering at all. */}
                      {showCurves && pattern !== undefined && (
                        <div
                          className="pl-curve"
                          style={{
                            left: `${clip.startBar * barPx}px`,
                            width: `${clip.lengthBars * barPx}px`
                          }}
                        >
                          <ClipCurve
                            clipId={clip.id}
                            volumeCurve={clip.volumeCurve}
                            pattern={pattern}
                            lengthBars={clip.lengthBars}
                            barSec={barSec}
                          />
                        </div>
                      )}
                    </Fragment>
                  )
                })}
            </div>
          </div>
        ))}

        {/* The selection rectangle, drawn on the grid rather than in a lane: it
            has to be able to run down a column of tracks. */}
        {box !== null && (
          <span
            className="pl-marquee"
            style={{
              left: `calc(var(--pl-head-w) + ${box.left}px)`,
              top: `calc(var(--pl-ruler-h) + ${box.top}px)`,
              width: `${box.width}px`,
              height: `${box.height}px`
            }}
          />
        )}

        {/* One line for the whole stack rather than one per lane: it is the same
            moment on every track. Drawn above the lanes and below the headers,
            which are pinned and must stay readable. Always there, because where
            the song will start is worth seeing before the song is running. */}
        <div
          className="pl-playhead"
          data-playing={playing}
          style={{ left: `calc(var(--pl-head-w) + ${playheadBar * barPx}px)` }}
        >
          {/* Two pixels is not something to aim at. The line keeps passing the
              press through to whatever is underneath; this is what takes it. */}
          <span
            className="pl-playhead__grab"
            onPointerDown={startCursorDrag}
            title="拖动改变播放起点"
          />
        </div>
      </div>
    </section>
  )
}

export default Playlist
