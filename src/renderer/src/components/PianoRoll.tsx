import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { usePanelSize } from '../hooks/usePanelSize'
import { usePianoRollHead } from '../hooks/usePianoRollHead'
import { usePlayheadSec } from '../hooks/usePlayheadSec'
import {
  selectChannelPlayback,
  selectCurrentPattern,
  selectLengthBars,
  selectNotes,
  selectPianoRollStartSec,
  useDawStore
} from '../state/useDawStore'
import type { Channel, Sample } from '../state/useDawStore'
import BpmField from './BpmField'
import PianoKeys from './PianoKeys'
import {
  BEATS_PER_BAR,
  GRID_DIVISIONS,
  KEY_HEIGHT_PX,
  LENGTH_BAR_OPTIONS,
  MAX_KEY_PX,
  MAX_STEP_PX,
  MIN_KEY_PX,
  MIN_STEP_PX,
  PIANO_KEY_COUNT,
  STEP_PX,
  STEPS_PER_BEAT,
  clampRow,
  gridLabel,
  isBlackKey,
  noteName,
  pitchForRow,
  rowForPitch,
  secondsPerBar,
  secondsPerBeat,
  secondsPerStep,
  sequenceSec,
  snapSec,
  type Note
} from '../types/note'

type PianoRollProps = {
  channel: Channel
  sample: Sample | undefined
}

/** A rectangle in the grid's own pixel coordinates. */
type Rect = {
  x: number
  y: number
  width: number
  height: number
}

/**
 * An in-flight drag.
 *
 * The geometry at grab time is kept alongside the pointer's origin, so every move
 * recomputes from the origin instead of accumulating deltas — a drag that wanders
 * and comes back lands exactly where it started. For a group that is what keeps
 * the notes rigid relative to each other.
 */
type Drag =
  | {
      kind: 'move'
      pointerStartX: number
      pointerStartY: number
      /** Every note being dragged, as they were at grab time. */
      origins: Note[]
    }
  | {
      kind: 'resize'
      /**
       * Where the group's far edge was when the drag started.
       *
       * Held as an absolute time rather than as each note's length, because the
       * edge is what the pointer is holding: measured from here, the edge lands
       * under the pointer whatever part of it was actually grabbed.
       */
      originEndSec: number
      /** Every note being resized, as they were at grab time. */
      origins: Note[]
    }
  | {
      kind: 'marquee'
      pointerStartX: number
      pointerStartY: number
      /** Where the rectangle started, in grid pixels. */
      originX: number
      originY: number
      /** Whether the pointer has travelled far enough to call it a rectangle. */
      moved: boolean
      /** Whether the notes already selected stay selected. */
      additive: boolean
    }
  | {
      /** Dragging the play cursor along the ruler. */
      kind: 'cursor'
    }

/** Left gutter width, in pixels, that the ruler and the grid both start after. */
const KEYS_WIDTH_PX = 64
/** Height of the bar-number ruler, in pixels. */
const RULER_HEIGHT_PX = 18

/**
 * How far a selecting drag has to travel before it draws its rectangle.
 *
 * Below this it is a click, and a click on empty grid with Shift held clears the
 * selection rather than starting one.
 */
const MARQUEE_THRESHOLD_PX = 4

/** How much one zoom notch multiplies by, for the toolbar's buttons. */
const ZOOM_STEP = 1.25

/** The smallest the panel may be dragged to, in pixels. */
const MIN_PANEL_WIDTH_PX = 400
const MIN_PANEL_HEIGHT_PX = 300

/** The share of the window's height the panel opens at, until it is resized. */
const DEFAULT_PANEL_HEIGHT_RATIO = 0.66

/** Where the panel's size is kept between launches. A workspace setting, not a project one. */
const PANEL_SIZE_KEY = 'my-daw:piano-roll-size'

/** One shared empty selection, so "nothing is selected" is one identity. */
const NO_IDS: readonly string[] = []

/**
 * The Piano Roll for one channel: a time-by-pitch grid holding that channel's
 * note sequence.
 *
 * The horizontal axis is bars and beats, the vertical axis is pitch — one lane
 * per semitone of the keyboard beside it. Both axes are zoomable and both scroll,
 * with the ruler and the keyboard pinned to their edges.
 *
 * Notes are stored in seconds, which is what the engine schedules against, so
 * every position drawn here is that note's own time rather than a step index.
 */
function PianoRoll({ channel, sample }: PianoRollProps): React.JSX.Element {
  const closePianoRoll = useDawStore((state) => state.closePianoRoll)
  const addNote = useDawStore((state) => state.addNote)
  const addNotes = useDawStore((state) => state.addNotes)
  const moveNotes = useDawStore((state) => state.moveNotes)
  const resizeNotes = useDawStore((state) => state.resizeNotes)
  const removeNotes = useDawStore((state) => state.removeNotes)
  const previewPitch = useDawStore((state) => state.previewPitch)
  const playPianoRoll = useDawStore((state) => state.playPianoRoll)
  const stopSequence = useDawStore((state) => state.stopSequence)
  const loopEnabled = useDawStore((state) => state.loopEnabled)
  const toggleLoop = useDawStore((state) => state.toggleLoop)
  const setPatternLengthBars = useDawStore((state) => state.setPatternLengthBars)
  const snapEnabled = useDawStore((state) => state.snapEnabled)
  const toggleSnap = useDawStore((state) => state.toggleSnap)
  const gridDivision = useDawStore((state) => state.gridDivision)
  const setGridDivision = useDawStore((state) => state.setGridDivision)
  const setPianoRollStart = useDawStore((state) => state.setPianoRollStart)
  const cursorSec = useDawStore(selectPianoRollStartSec)
  const tool = useDawStore((state) => state.pianoRollTool)
  const setPianoRollTool = useDawStore((state) => state.setPianoRollTool)

  const scrollRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<Drag | null>(null)
  const panelRef = useRef<HTMLElement>(null)

  // The panel's own size, dragged from its edges and remembered between launches.
  const { size: panelSize, beginResize } = usePanelSize(
    PANEL_SIZE_KEY,
    panelRef,
    { width: null, height: window.innerHeight * DEFAULT_PANEL_HEIGHT_RATIO },
    MIN_PANEL_WIDTH_PX,
    MIN_PANEL_HEIGHT_PX
  )

  /**
   * Whether Shift is down, followed on the window rather than read off events.
   *
   * A press carries its own `shiftKey`, which is the obvious source; the box
   * select gesture has stopped depending on it being right, and this is the
   * second line of defence for the shortcuts that still go through modifiers.
   */
  const shiftRef = useRef(false)
  useEffect(() => {
    // `keyup` carries the state after the key, which is what makes a release read
    // as false. A window that loses focus while Shift is down never sees the
    // release at all, so blur has to clear it.
    const sync = (event: KeyboardEvent): void => {
      shiftRef.current = event.shiftKey
    }
    const clear = (): void => {
      shiftRef.current = false
    }
    window.addEventListener('keydown', sync)
    window.addEventListener('keyup', sync)
    window.addEventListener('blur', clear)
    return () => {
      window.removeEventListener('keydown', sync)
      window.removeEventListener('keyup', sync)
      window.removeEventListener('blur', clear)
    }
  }, [])

  /**
   * Where the content under the pointer should still be after a zoom.
   *
   * Kept for the layout effect below rather than applied here: the element's
   * scrollable size only changes once the zoom has re-rendered, and a scroll
   * position set any earlier is clamped by the size it is leaving.
   */
  const zoomAnchorRef = useRef<{ offsetX: number; offsetY: number; x: number; y: number } | null>(
    null
  )

  /**
   * Whether the next layout pass should put the sample's own pitch back in the
   * middle of the view.
   *
   * True to begin with, so opening the roll lands on the pitch most parts are
   * written around instead of somewhere up in the top octave, and set again by
   * the toolbar's reset button.
   */
  const recentreRef = useRef(true)

  /** Zoom, as the pixels one 1/16 step and one key take up. */
  const [stepPx, setStepPx] = useState(STEP_PX)
  const [keyPx, setKeyPx] = useState(KEY_HEIGHT_PX)

  // Read here rather than imported as constants: the tempo and the pattern's
  // length can both change while the roll is open, and the grid has to keep
  // describing what will be heard.
  const bpm = useDawStore((state) => state.bpm)
  const lengthBars = useDawStore(selectLengthBars)
  const patternName = useDawStore((state) => selectCurrentPattern(state)?.name ?? '')

  // Notes come from the current pattern, so switching pattern re-points the whole
  // grid at different content without the panel remounting.
  const notes = useDawStore((state) => selectNotes(state, channel.id))
  const selectionKey = `${channel.id}:${patternName}`

  /**
   * The notes the group actions apply to.
   *
   * Held here rather than in the store because nothing outside this panel has an
   * opinion about it: every store action below takes the ids it should act on, so
   * a selection cannot go stale behind a pattern switch.
   *
   * Which pattern it belongs to is stored with it: a selection made in one pattern
   * means nothing in another, and reading that off the stored key drops it during
   * the render that notices rather than one effect later.
   */
  const [selection, setSelection] = useState<{ key: string; ids: readonly string[] }>({
    key: selectionKey,
    ids: []
  })
  const selectedIds = useMemo(
    () => (selection.key === selectionKey ? selection.ids : NO_IDS),
    [selection, selectionKey]
  )
  const setSelectedIds = useCallback(
    (next: readonly string[] | ((current: readonly string[]) => readonly string[])): void => {
      setSelection((current) => ({
        key: selectionKey,
        ids:
          typeof next === 'function' ? next(current.key === selectionKey ? current.ids : []) : next
      }))
    },
    [selectionKey]
  )
  const selected = useMemo(() => new Set(selectedIds), [selectedIds])

  const [marquee, setMarquee] = useState<Rect | null>(null)
  /** Copied notes, placed relative to the earliest of them. Null until a copy. */
  const clipboardRef = useRef<Note[] | null>(null)
  /** Where the last paste landed, so a repeated paste can move on from it. */
  const lastPasteRef = useRef<number | null>(null)

  // The transport is global, so this panel only follows it while it is this
  // channel's own playback — never a whole song.
  const playback = useDawStore((state) => selectChannelPlayback(state, channel.id))
  const isPlaying = playback !== null
  // The piano roll's own transport wraps, so it answers its own cursor; a
  // sequence started from the channel rack counts up like any other.
  const loopHeadSec = usePianoRollHead(playback)
  const plainHeadSec = usePlayheadSec(loopHeadSec === null ? playback : null)
  const playheadSec = loopHeadSec ?? plainHeadSec

  /**
   * Where the white line is drawn.
   *
   * Those are two different lines: the transport's position while it runs, and
   * the start the roll will play from while it is stopped. Both are the same line
   * on the grid, so they are the same element — which is what makes the cursor
   * something you can see and drag rather than something you have to remember.
   */
  const lineSec = isPlaying ? playheadSec : cursorSec

  const stepSec = secondsPerStep(bpm)
  const beatSec = secondsPerBeat(bpm)
  const barSec = secondsPerBar(bpm)
  const sequenceLengthSec = sequenceSec(bpm, lengthBars)
  const gridWidthPx = lengthBars * BEATS_PER_BAR * STEPS_PER_BEAT * stepPx
  const gridHeightPx = PIANO_KEY_COUNT * keyPx
  /** One cell of the snap grid, in pixels. What the fine lines are drawn at. */
  const cellPx = (stepPx * STEPS_PER_BEAT) / gridDivision

  /** Whether a drag lands on the grid: off while Alt is held, or the switch is off. */
  const snapping = useCallback((altKey: boolean): boolean => snapEnabled && !altKey, [snapEnabled])

  /**
   * Whether a press on empty grid is asking to select rather than to draw.
   *
   * The 框选 tool is the way in, and Shift still works as it always did — the
   * tool existing is what keeps box selecting reachable when a modifier does not
   * arrive, which is the whole reason it was added.
   */
  const selecting = useCallback(
    (event: Pick<React.PointerEvent, 'shiftKey'>): boolean =>
      tool === 'select' || event.shiftKey || shiftRef.current,
    [tool]
  )

  /** Where a note is drawn, which is also how it is hit-tested. */
  const rectForNote = useCallback(
    (note: Note): Rect => ({
      x: (note.startSec / stepSec) * stepPx,
      y: rowForPitch(note.pitch) * keyPx,
      width: Math.max(2, (note.lengthSec / stepSec) * stepPx),
      height: keyPx
    }),
    [stepSec, stepPx, keyPx]
  )

  /** Grid pixels under a pointer. The grid's rect moves with the scroll, so this
   *  is content space however far the grid has been scrolled. */
  const contentXAt = useCallback((clientX: number): number => {
    const rect = gridRef.current?.getBoundingClientRect()
    return rect ? clientX - rect.left : 0
  }, [])

  const contentYAt = useCallback((clientY: number): number => {
    const rect = gridRef.current?.getBoundingClientRect()
    return rect ? clientY - rect.top : 0
  }, [])

  /** A time on the grid, in seconds. */
  const timeAt = useCallback(
    (clientX: number): number => (contentXAt(clientX) / stepPx) * stepSec,
    [contentXAt, stepPx, stepSec]
  )

  /** A key row under a pointer, clamped to the keyboard. */
  const rowAt = useCallback(
    (clientY: number): number => clampRow(Math.floor(contentYAt(clientY) / keyPx)),
    [contentYAt, keyPx]
  )

  /**
   * Keep the zoomed-to point under the pointer, and put the sample's pitch back in
   * the middle when a reset asked for it.
   *
   * Runs after the render that changed the zoom, which is the first moment the
   * scroll container is as big as the new zoom makes it — and the first moment the
   * new key height is known, which is what the centring has to be measured with.
   */
  useLayoutEffect(() => {
    const element = scrollRef.current
    if (!element) return

    const anchor = zoomAnchorRef.current
    if (anchor) {
      element.scrollLeft = anchor.x - anchor.offsetX
      element.scrollTop = anchor.y - anchor.offsetY
      zoomAnchorRef.current = null
    }

    if (recentreRef.current) {
      recentreRef.current = false
      element.scrollTop = Math.max(0, (rowForPitch(0) + 0.5) * keyPx - element.clientHeight / 2)
    }
  }, [stepPx, keyPx])

  // Ctrl+wheel zooms the time axis, Ctrl+Shift+wheel the keyboard. Registered by
  // hand rather than through React's onWheel, which is passive: the browser's own
  // page zoom has to be suppressed, and a passive listener cannot.
  useEffect(() => {
    const element = scrollRef.current
    if (!element) return

    const handleWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey) return // Otherwise it is a scroll; leave it alone.
      event.preventDefault()

      const rect = element.getBoundingClientRect()
      const offsetX = event.clientX - rect.left
      const offsetY = event.clientY - rect.top
      // Exponential, so a trackpad's many small deltas and a mouse's few big ones
      // both feel like the same gesture.
      const factor = Math.exp(-event.deltaY * 0.0025)

      zoomAnchorRef.current = {
        offsetX,
        offsetY,
        x: element.scrollLeft + offsetX,
        y: element.scrollTop + offsetY
      }

      if (event.shiftKey) {
        setKeyPx((current) => clampZoom(current * factor, MIN_KEY_PX, MAX_KEY_PX))
      } else {
        setStepPx((current) => clampZoom(current * factor, MIN_STEP_PX, MAX_STEP_PX))
      }
    }

    element.addEventListener('wheel', handleWheel, { passive: false })
    return () => element.removeEventListener('wheel', handleWheel)
  }, [])

  /** Drags are tracked on the window: the pointer is free to leave the grid. */
  useEffect(() => {
    const handlePointerMove = (event: PointerEvent): void => {
      const drag = dragRef.current
      if (!drag || !gridRef.current) return

      if (drag.kind === 'cursor') {
        setPianoRollStart(
          snapping(event.altKey)
            ? snapSec(timeAt(event.clientX), bpm, gridDivision)
            : timeAt(event.clientX)
        )
        return
      }

      if (drag.kind === 'resize') {
        // Measured from where the group's edge was, so the edge follows the
        // pointer and every note in the group grows by the same amount.
        const deltaSec = timeAt(event.clientX) - drag.originEndSec
        resizeNotes(channel.id, drag.origins, deltaSec, snapping(event.altKey))
        return
      }

      if (drag.kind === 'marquee') {
        const x = contentXAt(event.clientX)
        const y = contentYAt(event.clientY)
        const travelledX = Math.abs(event.clientX - drag.pointerStartX)
        const travelledY = Math.abs(event.clientY - drag.pointerStartY)
        if (!drag.moved && Math.max(travelledX, travelledY) < MARQUEE_THRESHOLD_PX) return
        drag.moved = true

        const box: Rect = {
          x: Math.min(drag.originX, x),
          y: Math.min(drag.originY, y),
          width: Math.abs(x - drag.originX),
          height: Math.abs(y - drag.originY)
        }
        setMarquee(box)

        // Selected live, so the rectangle shows what it is about to take rather
        // than what it took.
        const caught = notes
          .filter((note) => intersects(rectForNote(note), box))
          .map((note) => note.id)
        setSelectedIds((current) =>
          drag.additive ? [...new Set([...current, ...caught])] : caught
        )
        return
      }

      const deltaSec = ((event.clientX - drag.pointerStartX) / stepPx) * stepSec
      // Rows count down from the top, so moving the pointer down lowers the pitch.
      const deltaRows = Math.round((event.clientY - drag.pointerStartY) / keyPx)
      // Alt is the escape hatch from the grid: it drops the snap for as long as it
      // is held, without changing the grid itself. A group is snapped as a group,
      // so the spacing inside it survives the drag.
      moveNotes(channel.id, drag.origins, deltaSec, -deltaRows, snapping(event.altKey))
    }

    const handlePointerUp = (): void => {
      const drag = dragRef.current
      dragRef.current = null
      setMarquee(null)

      // A selecting press that never travelled is a click on empty grid, which is
      // how a selection is let go of. Ctrl was asking to keep it, so it does.
      if (drag?.kind === 'marquee' && !drag.moved && !drag.additive) setSelectedIds([])
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerUp)
    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerUp)
    }
  }, [
    channel.id,
    moveNotes,
    resizeNotes,
    setSelectedIds,
    setPianoRollStart,
    snapping,
    notes,
    rectForNote,
    contentXAt,
    contentYAt,
    timeAt,
    stepPx,
    keyPx,
    stepSec,
    bpm,
    gridDivision
  ])

  /**
   * The panel's keyboard: what to do with the selection.
   *
   * Registered while the panel is open, and never when a text field has focus —
   * the BPM box and the pattern rename box are the panel's neighbours and their
   * own keystrokes are none of this handler's business.
   */
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea') != null) return

      const modifier = event.ctrlKey || event.metaKey

      if (modifier && event.key.toLowerCase() === 'a') {
        event.preventDefault()
        setSelectedIds(notes.map((note) => note.id))
        return
      }

      if (modifier && event.key.toLowerCase() === 'c') {
        if (selectedIds.length === 0) return
        event.preventDefault()
        const picked = notes.filter((note) => selected.has(note.id))
        const earliestSec = Math.min(...picked.map((note) => note.startSec))
        clipboardRef.current = picked.map((note) => ({
          ...note,
          startSec: note.startSec - earliestSec
        }))
        return
      }

      if (modifier && event.key.toLowerCase() === 'v') {
        const copied = clipboardRef.current
        if (copied === null || copied.length === 0) return
        event.preventDefault()
        // Placed at the white line, on the grid: what was copied keeps its internal
        // timing, and where it lands is where the cursor is. Pasting again while
        // the cursor has not moved would land the copies on top of the previous
        // ones, so a repeat moves on by one group's length instead.
        const atSec = snapSec(lineSec, bpm, gridDivision)
        const spanSec = Math.max(...copied.map((note) => note.startSec + note.lengthSec))
        const landingSec = lastPasteRef.current === atSec ? atSec + spanSec : atSec
        lastPasteRef.current = landingSec
        const pasted = copied.map((note) => ({
          ...note,
          id: crypto.randomUUID(),
          startSec: note.startSec + landingSec
        }))
        addNotes(channel.id, pasted)
        setSelectedIds(pasted.map((note) => note.id))
        return
      }

      if (modifier && event.key.toLowerCase() === 'd') {
        if (selectedIds.length === 0) return
        event.preventDefault()
        const picked = notes.filter((note) => selected.has(note.id))
        // One group-length to the right, which is the only offset that makes a
        // duplicate a separate thing to hear rather than a stacked one.
        const earliestSec = Math.min(...picked.map((note) => note.startSec))
        const latestSec = Math.max(...picked.map((note) => note.startSec + note.lengthSec))
        const offsetSec = latestSec - earliestSec
        const copies = picked.map((note) => ({
          ...note,
          id: crypto.randomUUID(),
          startSec: note.startSec + offsetSec
        }))
        addNotes(channel.id, copies)
        setSelectedIds(copies.map((note) => note.id))
        return
      }

      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (selectedIds.length === 0) return
        event.preventDefault()
        removeNotes(channel.id, [...selectedIds])
        setSelectedIds([])
        return
      }

      if (event.key === 'Escape') {
        setSelectedIds([])
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [
    channel.id,
    notes,
    selectedIds,
    selected,
    setSelectedIds,
    lineSec,
    bpm,
    gridDivision,
    addNotes,
    removeNotes
  ])

  const startDrag = (event: React.PointerEvent, drag: Drag): void => {
    if (event.button !== 0) return
    // Keeps the grid from treating this as a press on empty space.
    event.stopPropagation()
    // Taken by the element the press landed on, so a drag that leaves the window
    // still ends when the button comes up outside it: without this the release
    // would be missed, and the next move over the grid would carry the drag on.
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = drag
  }

  /**
   * A press on a note.
   *
   * A note inside the selection drags the whole selection; one outside it becomes
   * the selection and drags alone, which is what makes a group reachable without
   * first clicking away from it.
   */
  const handleNotePointerDown = (event: React.PointerEvent, note: Note): void => {
    if (event.button !== 0) return

    const inSelection = selected.has(note.id)
    const ids = inSelection ? selectedIds : [note.id]
    if (!inSelection) setSelectedIds([note.id])

    startDrag(event, {
      kind: 'move',
      pointerStartX: event.clientX,
      pointerStartY: event.clientY,
      origins: notes.filter((item) => ids.includes(item.id))
    })
  }

  /**
   * A press on the right edge of a note: change its length, and the length of
   * everything selected with it.
   *
   * The group's far edge is what the pointer takes hold of, so the notes to its
   * left grow by the same amount and the shape of the group survives the resize —
   * the same rule the group move follows.
   */
  const handleHandlePointerDown = (event: React.PointerEvent, note: Note): void => {
    if (event.button !== 0) return

    const inSelection = selected.has(note.id)
    if (!inSelection) setSelectedIds([note.id])
    const ids = inSelection ? selectedIds : [note.id]

    startDrag(event, {
      kind: 'resize',
      originEndSec: note.startSec + note.lengthSec,
      origins: notes.filter((item) => ids.includes(item.id))
    })
  }

  /**
   * A press on empty grid.
   *
   * With the draw tool the bare gesture draws: the note appears where the press
   * landed and its length follows the pointer, which is FL's own default and the
   * reason a note can be written in one movement. With the select tool the same
   * gesture drags out a rectangle instead, so box selecting no longer depends on
   * a modifier arriving; Ctrl extends what is already selected rather than
   * starting again, in either tool.
   */
  const handleGridPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return

    if (selecting(event)) {
      startDrag(event, {
        kind: 'marquee',
        pointerStartX: event.clientX,
        pointerStartY: event.clientY,
        originX: contentXAt(event.clientX),
        originY: contentYAt(event.clientY),
        moved: false,
        additive: event.ctrlKey || event.metaKey
      })
      return
    }

    const note = addNote(
      channel.id,
      timeAt(event.clientX),
      pitchForRow(rowAt(event.clientY)),
      snapping(event.altKey)
    )
    setSelectedIds([note.id])
    // Zero at the grab, so the length the pointer drags out is the length the note
    // gets: the edge follows the pointer rather than starting a cell ahead of it.
    startDrag(event, {
      kind: 'resize',
      originEndSec: note.startSec,
      origins: [{ ...note, lengthSec: 0 }]
    })
  }

  /** A press on the ruler sets where playback starts from. */
  const handleRulerPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    event.preventDefault()
    const atSec = timeAt(event.clientX)
    setPianoRollStart(snapping(event.altKey) ? snapSec(atSec, bpm, gridDivision) : atSec)
    startDrag(event, { kind: 'cursor' })
  }

  const handlePreview = useCallback(
    (pitch: number) => {
      void previewPitch(channel.id, pitch)
    },
    [previewPitch, channel.id]
  )

  /** One zoom notch, as the toolbar's buttons ask for it. */
  const zoomBy = (factor: number): void => {
    const element = scrollRef.current
    if (element) {
      // Anchored on the middle of the view, since there is no pointer to anchor on.
      const offsetX = element.clientWidth / 2
      const offsetY = element.clientHeight / 2
      zoomAnchorRef.current = {
        offsetX,
        offsetY,
        x: element.scrollLeft + offsetX,
        y: element.scrollTop + offsetY
      }
    }
    setStepPx((current) => clampZoom(current * factor, MIN_STEP_PX, MAX_STEP_PX))
    setKeyPx((current) => clampZoom(current * factor, MIN_KEY_PX, MAX_KEY_PX))
  }

  const resetZoom = (): void => {
    zoomAnchorRef.current = null
    recentreRef.current = true
    setStepPx(STEP_PX)
    setKeyPx(KEY_HEIGHT_PX)
  }

  const zoomPercent = Math.round((stepPx / STEP_PX) * 100)

  // Grid line spacing in pixels: the notes are positioned with these same
  // numbers, so the lines and the notes cannot disagree about where a step is.
  const canvasStyle = {
    '--pr-keys-w': `${KEYS_WIDTH_PX}px`,
    '--pr-ruler-h': `${RULER_HEIGHT_PX}px`,
    '--pr-grid-w': `${gridWidthPx}px`,
    '--pr-grid-h': `${gridHeightPx}px`,
    '--pr-cell-w': `${cellPx}px`,
    '--pr-beat-w': `${stepPx * STEPS_PER_BEAT}px`,
    '--pr-bar-w': `${stepPx * STEPS_PER_BEAT * BEATS_PER_BAR}px`
  } as React.CSSProperties

  // Bar and beat rather than seconds: it is what the ruler above the notes says,
  // so the readout and the grid agree about where the line is.
  const positionBar = Math.floor(lineSec / barSec) + 1
  const positionBeat = Math.floor((lineSec % barSec) / beatSec) + 1

  return (
    <section
      className="piano-roll"
      aria-label="钢琴卷帘"
      ref={panelRef}
      // Height is always ours; width only once an edge has been dragged, so a
      // panel nobody has resized still follows the window the way it used to.
      style={{
        height: `${panelSize.height}px`,
        width: panelSize.width === null ? undefined : `${panelSize.width}px`
      }}
    >
      {/* The panel's edges. They lie over the content, which is what keeps a grab
          at the very edge from landing on the grid behind it. */}
      <span
        className="pr-resize"
        data-edge="top"
        title="拖动改变高度"
        onPointerDown={(event) => beginResize('top', event)}
      />
      <span
        className="pr-resize"
        data-edge="left"
        title="拖动改变宽度"
        onPointerDown={(event) => beginResize('left', event)}
      />
      <span
        className="pr-resize"
        data-edge="right"
        title="拖动改变宽度"
        onPointerDown={(event) => beginResize('right', event)}
      />
      <span
        className="pr-resize"
        data-edge="corner"
        title="拖动同时改变宽高"
        onPointerDown={(event) => beginResize('corner', event)}
      />

      <header className="pr__header">
        <span className="pr__title">钢琴卷帘 · {channel.name}</span>
        <span className="pr__pattern" title="当前 Pattern">
          {patternName}
        </span>
        <span className="pr__meta">
          {sample
            ? `${notes.length} 个音符 · ${bpm} BPM · ${lengthBars} 小节 · ${sequenceLengthSec.toFixed(2)}s`
            : '采样缺失'}
        </span>
        <button
          type="button"
          className="pr__close"
          onClick={closePianoRoll}
          title="关闭钢琴卷帘"
          aria-label="关闭钢琴卷帘"
        >
          ×
        </button>
      </header>

      <div className="pr__transport">
        <button
          type="button"
          className="pr__play"
          onClick={() => {
            if (isPlaying) {
              stopSequence()
            } else {
              void playPianoRoll(channel.id)
            }
          }}
          disabled={notes.length === 0}
          aria-pressed={isPlaying}
          title={notes.length === 0 ? '先画一个音符' : '播放 / 停止该通道的音符（空格）'}
        >
          {isPlaying ? '⏹ 停止' : '▶ 播放'}
        </button>

        <button
          type="button"
          className="pr__loop"
          aria-pressed={loopEnabled}
          onClick={toggleLoop}
          title={loopEnabled ? '循环已开：播到末尾回到起点' : '循环已关：播到末尾停下'}
        >
          🔁 循环
        </button>

        <BpmField />

        <div className="pr__length" role="group" aria-label="工具">
          <span className="pr__length-label">工具</span>
          {(['draw', 'select'] as const).map((option) => (
            <button
              key={option}
              type="button"
              className="pr__length-option"
              aria-pressed={tool === option}
              onClick={() => setPianoRollTool(option)}
              title={
                option === 'draw'
                  ? '画笔：空白拖动画音符，拖出长度'
                  : '框选：空白拖动拉出矩形，框住经过的音符（Ctrl 追加选择）'
              }
            >
              {option === 'draw' ? '✏ 画笔' : '▭ 框选'}
            </button>
          ))}
        </div>

        <div className="pr__length" role="group" aria-label="Pattern 长度（小节）">
          <span className="pr__length-label">长度</span>
          {LENGTH_BAR_OPTIONS.map((option) => (
            <button
              key={option}
              type="button"
              className="pr__length-option"
              aria-pressed={option === lengthBars}
              onClick={() => setPatternLengthBars(option)}
              title={`${option} 小节`}
            >
              {option}
            </button>
          ))}
        </div>

        <div className="pr__length" role="group" aria-label="网格细分">
          <span className="pr__length-label">细分</span>
          {GRID_DIVISIONS.map((division) => (
            <button
              key={division}
              type="button"
              className="pr__length-option"
              aria-pressed={division === gridDivision}
              onClick={() => setGridDivision(division)}
              title={`吸附到 ${gridLabel(division)} 音符`}
            >
              {gridLabel(division)}
            </button>
          ))}
        </div>

        <button
          type="button"
          className="pr__loop pr__snap"
          aria-pressed={snapEnabled}
          onClick={toggleSnap}
          title={
            snapEnabled
              ? '吸附已开：位置和长度都落在网格上（按住 Alt 临时取消）'
              : '吸附已关：位置和长度都是自由的（按住 Alt 无效）'
          }
        >
          🧲 吸附
        </button>

        <div className="pr__zoom" role="group" aria-label="缩放">
          <span className="pr__length-label">缩放</span>
          <button
            type="button"
            className="pr__length-option"
            onClick={() => zoomBy(1 / ZOOM_STEP)}
            title="缩小（Ctrl+滚轮）"
          >
            −
          </button>
          <span className="pr__zoom-value">{zoomPercent}%</span>
          <button
            type="button"
            className="pr__length-option"
            onClick={() => zoomBy(ZOOM_STEP)}
            title="放大（Ctrl+滚轮）"
          >
            ＋
          </button>
          <button type="button" className="pr__length-option" onClick={resetZoom} title="复位缩放">
            复位
          </button>
        </div>

        <span className="pr__position" title="播放起点 / 播放位置">
          {positionBar}.{positionBeat} · {lineSec.toFixed(2)} / {sequenceLengthSec.toFixed(2)} s
        </span>

        {selectedIds.length > 0 && (
          <span className="pr__selection">已选 {selectedIds.length} 个</span>
        )}

        <span className="pr__hint">
          空白拖动＝画音符（拖出长度）· 「框选」工具或 Shift+拖动＝框选 · 右边缘拖动＝改长度 ·
          标尺＝播放起点 · 拖动音符＝移动 · 右键＝删除 · 空格＝播放 · Ctrl+Z＝撤销 ·
          Ctrl+滚轮＝缩放 · Alt＝临时取消吸附
        </span>
      </div>

      <div className="pr__body">
        <div className="pr__scroll" ref={scrollRef}>
          <div className="pr__canvas" style={canvasStyle}>
            {/* Four cells: ruler and keyboard pinned to their edges by sticky,
                notes area filling the rest. */}
            <div className="pr__corner" />

            <div className="pr__ruler" onPointerDown={handleRulerPointerDown}>
              {Array.from({ length: lengthBars }, (_, index) => (
                <span key={index} className="pr__ruler-bar">
                  {index + 1}
                </span>
              ))}
              {/* The cursor, drawn in the ruler as well as in the grid: the ruler
                  is where it is set, so it has to be visible where it is aimed. */}
              <span
                className="pr__ruler-cursor"
                style={{ left: `${(lineSec / stepSec) * stepPx}px` }}
                data-playing={isPlaying}
              />
            </div>

            <PianoKeys keyHeightPx={keyPx} onPreview={handlePreview} />

            <div
              className="pr-grid"
              ref={gridRef}
              onPointerDown={handleGridPointerDown}
              onContextMenu={(event) => event.preventDefault()}
            >
              {/* One stripe per key row, so the black keys read as black keys and
                  the grid keeps telling the same story as the keyboard. */}
              <div className="pr-rows" aria-hidden="true">
                {Array.from({ length: PIANO_KEY_COUNT }, (_, row) => {
                  const pitch = pitchForRow(row)
                  return (
                    <div
                      key={row}
                      className="pr-row"
                      data-black={isBlackKey(pitch)}
                      data-root={pitch === 0}
                      style={{ height: `${keyPx}px` }}
                    />
                  )
                })}
              </div>

              {notes.map((note) => {
                const rect = rectForNote(note)
                return (
                  <div
                    key={note.id}
                    className="pr-note"
                    data-selected={selected.has(note.id)}
                    style={{
                      left: `${rect.x}px`,
                      width: `${rect.width}px`,
                      top: `${rect.y}px`,
                      height: `${Math.max(3, keyPx - 1)}px`,
                      background: channel.color,
                      // Velocity is audible, so it is visible too: a quiet note is
                      // a faded one, which is what FL's note colours do.
                      opacity: 0.45 + 0.55 * (note.velocity / 127)
                    }}
                    title={`${noteName(note.pitch)} · 第 ${Math.floor(note.startSec / barSec) + 1} 小节 ${Math.floor((note.startSec % barSec) / beatSec) + 1} 拍 · 长 ${note.lengthSec.toFixed(3)}s · 力度 ${note.velocity}`}
                    onPointerDown={(event) => handleNotePointerDown(event, note)}
                    onContextMenu={(event) => {
                      event.preventDefault()
                      // Right-clicking one of several removes the lot, the same as
                      // Delete would; right-clicking a lone note removes it.
                      const ids = selected.has(note.id) ? selectedIds : [note.id]
                      removeNotes(channel.id, [...ids])
                      setSelectedIds((current) =>
                        ids === selectedIds ? [] : current.filter((id) => id !== note.id)
                      )
                    }}
                  >
                    <span
                      className="pr-note__handle"
                      title="拖动改变长度（选中多个时一起变）"
                      onPointerDown={(event) => handleHandlePointerDown(event, note)}
                    />
                  </div>
                )
              })}

              {marquee !== null && (
                <div
                  className="pr-marquee"
                  style={{
                    left: `${marquee.x}px`,
                    top: `${marquee.y}px`,
                    width: `${marquee.width}px`,
                    height: `${marquee.height}px`
                  }}
                />
              )}

              {/* Only grabbable when it is the cursor: while the transport owns it,
                  the line is a readout and must not intercept a press meant for a
                  note underneath it. */}
              <div
                className="pr-playhead"
                data-cursor={!isPlaying}
                style={{ left: `${(lineSec / stepSec) * stepPx}px` }}
                onPointerDown={
                  isPlaying
                    ? undefined
                    : (event) => {
                        startDrag(event, { kind: 'cursor' })
                      }
                }
              />
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

function clampZoom(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/** Whether two rectangles overlap. Touching edges do not count. */
function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

export default PianoRoll
