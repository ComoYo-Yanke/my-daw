import { create } from 'zustand'

export type WindowMode = 'docked' | 'floating'

/** Every panel that can be a window. The set is closed: these are the panels. */
export type WindowId = 'channel-rack' | 'piano-roll' | 'playlist' | 'sample-browser'

/** A rectangle in viewport coordinates: the same space `getBoundingClientRect` uses. */
export type Rect = { x: number; y: number; width: number; height: number }

export type WindowState = {
  id: WindowId
  /** The panel's own name, for the window menu. A window may draw a longer one. */
  title: string
  mode: WindowMode
  /** Top-left corner, in viewport pixels. */
  position: { x: number; y: number }
  size: { width: number; height: number }
  /** A focus counter, not a CSS value. `selectWindowZ` turns it into one. */
  zIndex: number
  minimized: boolean
  closed: boolean
  alwaysOnTop: boolean
}

/** Nothing may be dragged or resized below this. */
export const MIN_WINDOW_WIDTH = 400
export const MIN_WINDOW_HEIGHT = 300

/** The title bar's height. `main.css` draws it to match, and a minimized window is this tall. */
export const TITLEBAR_HEIGHT_PX = 28

/**
 * How much of a floating window has to stay on screen.
 *
 * A floating window may hang off the right and bottom of the app window — that
 * is most of what "floating" buys over "docked". What it may not do is leave the
 * screen entirely, because its title bar is the only thing that can drag it back.
 */
const REACH_PX = 120

/**
 * The bottom of the window stack.
 *
 * Windows live at 10..13, which leaves the toolbar's dropdowns (20), the context
 * menu and toast (40) and the confirm dialog (50) above all of them: a menu is
 * never something a window can cover.
 */
export const WINDOW_Z_BASE = 10

/** The tallest or widest a window may claim to be, whatever storage says. */
const MAX_STORED_PX = 16384

const STORAGE_KEY = 'my-daw:windows'

/** A window's shape before anyone has moved it. */
type WindowDef = {
  id: WindowId
  title: string
  mode: WindowMode
  position: { x: number; y: number }
  size: { width: number; height: number }
  closed: boolean
}

/**
 * Roughly where the workspace begins, in viewport pixels.
 *
 * The default positions below are written as if the workspace started at the
 * origin — rack at the top, timeline underneath — and this is what turns that
 * into somewhere on screen, past the toolbar and the pattern bar.
 *
 * It only has to be close. The first measurement re-fits every docked window
 * into the workspace, so a value that is too large is pulled back to the top
 * edge. What the re-fit cannot do is undo an overlap, which is why the stacking
 * in the defaults is worked out against this number rather than left to chance.
 */
const WORKSPACE_TOP_PX = 100

/**
 * Where each window starts out.
 *
 * The rack and the timeline are open and stacked down the left, which is the
 * layout the app had before it grew windows; the piano roll and the library are
 * shut, since both are opened by doing something (double-clicking a channel,
 * pressing 采样库) and neither is useful before then.
 */
const WINDOW_DEFS: WindowDef[] = [
  {
    id: 'channel-rack',
    title: 'Channel Rack',
    mode: 'docked',
    position: { x: 16, y: 16 },
    size: { width: 900, height: 340 },
    closed: false
  },
  {
    id: 'playlist',
    title: 'Playlist',
    mode: 'docked',
    // Directly under the rack: 16 for the top margin, 340 for the rack's height
    // and 16 for the gap between them.
    position: { x: 16, y: 372 },
    size: { width: 900, height: 268 },
    closed: false
  },
  {
    id: 'sample-browser',
    title: '采样库',
    mode: 'docked',
    // To the right of the rack, not down the side of it as it used to be.
    position: { x: 932, y: 16 },
    size: { width: 400, height: 480 },
    closed: true
  },
  {
    id: 'piano-roll',
    title: '钢琴卷帘',
    mode: 'docked',
    position: { x: 120, y: 56 },
    size: { width: 900, height: 520 },
    closed: true
  }
]

/** A window's title, for anywhere that needs one before the window is rendered. */
export function windowTitle(id: WindowId): string {
  return WINDOW_DEFS.find((def) => def.id === id)?.title ?? id
}

// ---------------------------------------------------------------------------
// Layout presets
// ---------------------------------------------------------------------------

/**
 * How much daylight a preset leaves around a window.
 *
 * Taken out of the band a window is given rather than added between two of them:
 * neighbours are written as `width: 0.5` each, and the gap falls out of that
 * without anyone having to work out where the second one starts.
 */
const GUTTER_PX = 12

/**
 * A window's place in a preset, as fractions of the workspace.
 *
 * Fractions rather than pixels because a preset is applied to whatever size the
 * workspace happens to be — the app window is resizable, and two windows that
 * share the width have to go on sharing it. Read as a band rather than as a
 * rectangle: `{ x: 0.5, width: 0.5 }` is "the right half", with the gutter taken
 * out of the band it lands in.
 */
type LayoutSlot = {
  x: number
  y: number
  width: number
  height: number
  /** Whether the preset wants this window on screen at all. */
  open: boolean
}

export type LayoutId = 'arrange' | 'roll' | 'library'

export type LayoutPreset = {
  id: LayoutId
  label: string
  /** What it is for. The menu shows this as its tooltip. */
  hint: string
  /**
   * All four windows, not just the ones it opens.
   *
   * A preset is a whole arrangement, so it has to say where a window goes even
   * when it is leaving it shut: the next one to be opened from the menu should
   * land somewhere the layout put it, not wherever the last layout left it.
   */
  slots: Record<WindowId, LayoutSlot>
}

/**
 * The layouts the 窗口 menu offers.
 *
 * Three ways of working rather than three arrangements of the same panels: which
 * windows are up, and how the workspace is split between them. Applying one
 * docks everything and unpins anything, because that is what a layout is — the
 * point of picking one is that it comes out the same every time.
 *
 * 编曲 is the arrangement the app opens in. `resetLayout` also gets there, in the
 * pixel sizes the app was built with rather than in halves of whatever the
 * workspace is now; both are kept because a preset is chosen and a reset is
 * reached for when something is lost, and reaching for the first is not how
 * anyone finds their way back from the second.
 */
export const LAYOUT_PRESETS: LayoutPreset[] = [
  {
    id: 'arrange',
    label: '编曲',
    hint: '机架在上、时间线在下，右边一条留给采样库',
    slots: {
      'channel-rack': { x: 0, y: 0, width: 0.62, height: 0.48, open: true },
      playlist: { x: 0, y: 0.48, width: 0.62, height: 0.52, open: true },
      'sample-browser': { x: 0.62, y: 0, width: 0.38, height: 1, open: false },
      'piano-roll': { x: 0.62, y: 0, width: 0.38, height: 1, open: false }
    }
  },
  {
    id: 'roll',
    label: '钢琴卷帘',
    hint: '机架在上，卷帘占满下面，时间线让位',
    slots: {
      'channel-rack': { x: 0, y: 0, width: 1, height: 0.34, open: true },
      'piano-roll': { x: 0, y: 0.34, width: 1, height: 0.66, open: true },
      playlist: { x: 0, y: 0.34, width: 1, height: 0.66, open: false },
      'sample-browser': { x: 0.62, y: 0, width: 0.38, height: 1, open: false }
    }
  },
  {
    id: 'library',
    label: '采样库',
    hint: '机架在左、采样库在右，两边都占满高度',
    slots: {
      'channel-rack': { x: 0, y: 0, width: 0.58, height: 1, open: true },
      'sample-browser': { x: 0.58, y: 0, width: 0.42, height: 1, open: true },
      playlist: { x: 0, y: 0.5, width: 1, height: 0.5, open: false },
      'piano-roll': { x: 0, y: 0.34, width: 1, height: 0.66, open: false }
    }
  }
]

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high)
}

/**
 * The rectangle a mode is kept inside.
 *
 * Docked windows live in the workspace, so the workspace's own viewport rect is
 * the whole answer. Floating ones live in the app window, read live rather than
 * stored: it is one number the browser already knows, and caching it only makes
 * another thing to keep in step.
 */
function boundsFor(mode: WindowMode, workArea: Rect): Rect {
  if (mode === 'docked') return workArea
  return { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight }
}

/**
 * Where a window being dragged may sit.
 *
 * A docked window is kept whole inside the workspace. A floating one is only
 * kept reachable: enough of its title bar has to remain, and it may otherwise
 * hang off the right and bottom of the app window.
 */
function fitMove(rect: Rect, bounds: Rect, mode: WindowMode): { x: number; y: number } {
  const slackX = mode === 'docked' ? rect.width : REACH_PX
  const slackY = mode === 'docked' ? rect.height : TITLEBAR_HEIGHT_PX
  return {
    x: clamp(rect.x, bounds.x, Math.max(bounds.x, bounds.x + bounds.width - slackX)),
    y: clamp(rect.y, bounds.y, Math.max(bounds.y, bounds.y + bounds.height - slackY))
  }
}

/**
 * Where a window being resized may end.
 *
 * The edge that is not moving stays put, which is the whole reason this is not
 * the same function as `fitMove`: dragging the left edge in past the workspace
 * has to make the window narrower, not shove it sideways. The far edge is the
 * anchor, so the size gives way instead.
 */
function fitResize(rect: Rect, bounds: Rect, mode: WindowMode): Rect {
  let { x, y, width, height } = rect

  if (x < bounds.x) {
    width = Math.max(MIN_WINDOW_WIDTH, width - (bounds.x - x))
    x = bounds.x
  }
  if (y < bounds.y) {
    height = Math.max(MIN_WINDOW_HEIGHT, height - (bounds.y - y))
    y = bounds.y
  }

  // Floating windows may run off the right and bottom; docked ones may not.
  if (mode === 'docked') {
    const right = bounds.x + bounds.width
    const bottom = bounds.y + bounds.height
    if (x + width > right) width = Math.max(MIN_WINDOW_WIDTH, right - x)
    if (y + height > bottom) height = Math.max(MIN_WINDOW_HEIGHT, bottom - y)
  }

  return { x, y, width, height }
}

/** The same rect, so a no-op change can keep the window's identity intact. */
function sameRect(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

/**
 * A preset's slot, as a rectangle in the workspace.
 *
 * The minimum size wins over the fraction: a workspace small enough that half of
 * it is narrower than a window may be leaves the two overlapping, which is a
 * layout that can still be worked in and dragged apart. Quietly shrinking a
 * window past its minimum instead would give back something that cannot be
 * resized or read.
 */
function slotRect(slot: LayoutSlot, area: Rect): Rect {
  return {
    // Half the gutter on the outside, so a window filling the workspace sits the
    // same distance from all four of its edges.
    x: area.x + GUTTER_PX / 2 + Math.round(slot.x * area.width),
    y: area.y + GUTTER_PX / 2 + Math.round(slot.y * area.height),
    width: Math.max(MIN_WINDOW_WIDTH, Math.round(slot.width * area.width) - GUTTER_PX),
    height: Math.max(MIN_WINDOW_HEIGHT, Math.round(slot.height * area.height) - GUTTER_PX)
  }
}

/**
 * Make a window fit after the ground moved under it.
 *
 * Unlike a resize there is no edge to hold still, so the size gives way first
 * and the position follows. Called when the workspace is measured and whenever
 * it changes: a workspace that shrank can leave a window outside it with its
 * title bar and its resize handles both out of reach, which is a corner a user
 * cannot get out of without clearing storage by hand.
 */
function refit(win: WindowState, bounds: Rect): WindowState {
  // An unmeasured workspace has no opinion, and must not be mistaken for a tiny
  // one: shrinking every window to its minimum on the way past would be a layout
  // nobody asked for, and it would be written down.
  if (!(bounds.width > 0) || !(bounds.height > 0)) return win

  const size =
    win.mode === 'docked'
      ? {
          width: Math.min(win.size.width, Math.max(MIN_WINDOW_WIDTH, bounds.width)),
          height: Math.min(win.size.height, Math.max(MIN_WINDOW_HEIGHT, bounds.height))
        }
      : win.size
  const at = fitMove({ ...win.position, ...size }, bounds, win.mode)

  if (sameRect({ ...at, ...size }, { ...win.position, ...win.size })) return win
  return { ...win, position: at, size }
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readPoint(value: unknown): { x: number; y: number } | null {
  if (typeof value !== 'object' || value === null) return null
  const x = readNumber((value as { x?: unknown }).x)
  const y = readNumber((value as { y?: unknown }).y)
  if (x === null || y === null) return null
  return { x: clamp(x, -MAX_STORED_PX, MAX_STORED_PX), y: clamp(y, -MAX_STORED_PX, MAX_STORED_PX) }
}

function readSize(value: unknown): { width: number; height: number } | null {
  if (typeof value !== 'object' || value === null) return null
  const width = readNumber((value as { width?: unknown }).width)
  const height = readNumber((value as { height?: unknown }).height)
  if (width === null || height === null) return null
  return {
    // Absolute limits only. The work area has not been measured yet at this
    // point, and clamping against a rectangle that is still 0x0 would collapse
    // every window to nothing — and then persist the collapse.
    width: clamp(width, MIN_WINDOW_WIDTH, MAX_STORED_PX),
    height: clamp(height, MIN_WINDOW_HEIGHT, MAX_STORED_PX)
  }
}

function defaultWindow(def: WindowDef): WindowState {
  return {
    id: def.id,
    title: def.title,
    mode: def.mode,
    // Shifted down off the toolbar, so the defaults describe a layout inside the
    // workspace. A floating window's default would be its already-correct screen
    // position, so only the docked ones get it.
    position: {
      x: def.position.x,
      y: def.position.y + (def.mode === 'docked' ? WORKSPACE_TOP_PX : 0)
    },
    size: { ...def.size },
    zIndex: 0,
    minimized: false,
    closed: def.closed,
    alwaysOnTop: false
  }
}

/**
 * The defaults with whatever storage can vouch for laid over them.
 *
 * Field by field rather than all or nothing: one unreadable window should cost
 * that window its position, not cost every window its layout. A window id that
 * storage has never heard of — one added since it was written — simply gets its
 * default, so a new panel appears without anyone having to clear storage.
 */
function readStored(): WindowState[] {
  const stored = new Map<string, Record<string, unknown>>()
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          if (typeof entry === 'object' && entry !== null) {
            const id = (entry as { id?: unknown }).id
            if (typeof id === 'string') stored.set(id, entry as Record<string, unknown>)
          }
        }
      }
    }
  } catch {
    // No entry, unparseable, or storage disabled. The defaults are the answer.
  }

  return WINDOW_DEFS.map((def, index) => {
    // Defined order is stacking order for a layout nobody has touched yet: the
    // rack is in front of the timeline rather than the other way round.
    const base = { ...defaultWindow(def), zIndex: index + 1 }
    const raw = stored.get(def.id)
    if (raw === undefined) return base

    const mode = raw.mode === 'floating' || raw.mode === 'docked' ? raw.mode : base.mode
    return {
      ...base,
      mode,
      position: readPoint(raw.position) ?? base.position,
      size: readSize(raw.size) ?? base.size,
      zIndex: readNumber(raw.zIndex) ?? base.zIndex,
      minimized: raw.minimized === true,
      closed: raw.closed === true,
      alwaysOnTop: raw.alwaysOnTop === true
    }
  })
}

/**
 * Write the layout down.
 *
 * Called from the discrete actions and from the end of a drag, never from
 * `set`. `focusWindow` alone fires on every pointerdown in every window — every
 * step cell, every note — and `setGeometry` fires on every frame of a drag;
 * writing from either would put `localStorage.setItem` inside a gesture.
 */
export function persistWindowLayout(): void {
  try {
    const windows = useWindowStore.getState().windows
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(
        windows.map(({ id, mode, position, size, zIndex, minimized, closed, alwaysOnTop }) => ({
          id,
          mode,
          position,
          size,
          zIndex,
          minimized,
          closed,
          alwaysOnTop
        }))
      )
    )
  } catch {
    // Full, or disabled. The layout still works; it just forgets by next launch.
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * Replace one window and leave every other entry's identity alone.
 *
 * The identity is the point: this array is what `selectWindow` hands back, and
 * zustand compares with `Object.is`. Rebuilding all four objects on every frame
 * of a drag would re-render all four windows.
 */
function patchWindow(
  windows: WindowState[],
  id: WindowId,
  patch: (win: WindowState) => WindowState
): WindowState[] {
  return windows.map((win) => (win.id === id ? patch(win) : win))
}

/**
 * Whether a window is showing.
 *
 * A boolean rather than the window itself, so that anywhere that only needs to
 * know "is it up" does not re-render on every frame of somebody else's drag.
 */
export function selectWindowOpen(windows: WindowState[], id: WindowId): boolean {
  return windows.find((win) => win.id === id)?.closed === false
}

/**
 * A window's place in the stack, as a CSS `z-index`.
 *
 * Pinned windows sit above unpinned ones, and within each group the most
 * recently focused is on top — so pinning a window lifts it over everything
 * that is not also pinned, and clicking between two pinned windows still swaps
 * them. Rank rather than the raw counter, so the numbers stay inside the band
 * windows are allowed to occupy however many times focus is moved.
 */
export function selectWindowZ(windows: WindowState[], id: WindowId): number {
  const ordered = [...windows].sort((a, b) => {
    if (a.alwaysOnTop !== b.alwaysOnTop) return a.alwaysOnTop ? 1 : -1
    return a.zIndex - b.zIndex
  })
  return WINDOW_Z_BASE + ordered.findIndex((win) => win.id === id)
}

type WindowStore = {
  windows: WindowState[]
  /**
   * The workspace's viewport rectangle, or 0x0 before it has been measured.
   *
   * Kept here rather than in a context because the clamp is the store's job:
   * with the rectangle in hand the store can keep every window legal on its own,
   * and `DawWindow` stays a thing that draws a box.
   */
  workArea: Rect
  /** The highest focus counter handed out. */
  topZ: number

  openWindow: (id: WindowId) => void
  closeWindow: (id: WindowId) => void
  toggleWindow: (id: WindowId) => void
  minimizeWindow: (id: WindowId) => void
  focusWindow: (id: WindowId) => void
  toggleMode: (id: WindowId) => void
  toggleAlwaysOnTop: (id: WindowId) => void
  /** Move or resize. The patch says which: a size in it makes this a resize. */
  setGeometry: (id: WindowId, rect: Partial<Rect>) => void
  setWorkArea: (rect: Rect) => void
  resetLayout: () => void
  /** Put every window where one of the named layouts says. */
  applyLayout: (id: LayoutId) => void
}

/** The layout as this launch found it, before any of the actions have run. */
const initialWindows = readStored()

export const useWindowStore = create<WindowStore>((set, get) => ({
  windows: initialWindows,
  workArea: { x: 0, y: 0, width: 0, height: 0 },
  // Picked up from storage rather than started at the number of windows, so that
  // the window which was last focused last time is still recognised as the top
  // one: `focusWindow` compares against this to tell "already in front" from
  // "bring it forward", and a stale counter would make the first press on it
  // look like a move.
  topZ: initialWindows.reduce((top, win) => Math.max(top, win.zIndex), WINDOW_DEFS.length),

  /** Opening also brings forward: a panel that opens behind another is no use. */
  openWindow: (id) => {
    const state = get()
    set({
      windows: patchWindow(state.windows, id, (win) => ({
        ...win,
        closed: false,
        minimized: false,
        zIndex: state.topZ + 1
      })),
      topZ: state.topZ + 1
    })
    persistWindowLayout()
  },

  closeWindow: (id) => {
    set((state) => ({
      windows: patchWindow(state.windows, id, (win) =>
        win.closed ? win : { ...win, closed: true }
      )
    }))
    persistWindowLayout()
  },

  toggleWindow: (id) => {
    const win = get().windows.find((item) => item.id === id)
    if (win === undefined) return
    if (win.closed) {
      get().openWindow(id)
    } else {
      get().closeWindow(id)
    }
  },

  minimizeWindow: (id) => {
    set((state) => ({
      windows: patchWindow(state.windows, id, (win) => ({ ...win, minimized: !win.minimized }))
    }))
    persistWindowLayout()
  },

  /**
   * Bring a window to the front.
   *
   * Fires from a capture-phase press on anything inside a window, so it is the
   * hottest action here and the one that has to be cheapest: a window that is
   * already the most recently focused one is left exactly as it is, and no state
   * is written at all. Only moving between windows costs anything.
   */
  focusWindow: (id) => {
    const state = get()
    const win = state.windows.find((item) => item.id === id)
    if (win === undefined || win.zIndex === state.topZ) return
    set({
      windows: patchWindow(state.windows, id, (item) => ({ ...item, zIndex: state.topZ + 1 })),
      topZ: state.topZ + 1
    })
  },

  /** Switching modes re-fits: the two modes are kept inside different rectangles. */
  toggleMode: (id) => {
    set((state) => {
      const target = state.windows.find((win) => win.id === id)
      if (target === undefined) return state
      const mode: WindowMode = target.mode === 'docked' ? 'floating' : 'docked'
      const bounds = boundsFor(mode, state.workArea)
      return {
        windows: patchWindow(state.windows, id, (win) => ({
          ...refit({ ...win, mode }, bounds),
          zIndex: state.topZ + 1
        })),
        topZ: state.topZ + 1
      }
    })
    persistWindowLayout()
  },

  toggleAlwaysOnTop: (id) => {
    set((state) => ({
      windows: patchWindow(state.windows, id, (win) => ({
        ...win,
        alwaysOnTop: !win.alwaysOnTop
      }))
    }))
    persistWindowLayout()
  },

  setGeometry: (id, rect) => {
    set((state) => {
      const target = state.windows.find((win) => win.id === id)
      if (target === undefined) return state

      const requested: Rect = {
        x: rect.x ?? target.position.x,
        y: rect.y ?? target.position.y,
        width: rect.width ?? target.size.width,
        height: rect.height ?? target.size.height
      }
      const bounds = boundsFor(target.mode, state.workArea)
      // A patch carrying a size is a resize. The gesture itself is the only
      // place that distinction exists, so it is read off the patch rather than
      // guessed at from which numbers happen to have changed.
      const isResize = rect.width !== undefined || rect.height !== undefined

      const next: Rect = isResize
        ? fitResize(requested, bounds, target.mode)
        : {
            ...fitMove(requested, bounds, target.mode),
            width: requested.width,
            height: requested.height
          }

      const current: Rect = { ...target.position, ...target.size }
      if (sameRect(next, current)) return state

      return {
        windows: patchWindow(state.windows, id, (win) => ({
          ...win,
          position: { x: next.x, y: next.y },
          size: { width: next.width, height: next.height }
        }))
      }
    })
  },

  /**
   * Where the workspace is now, in viewport pixels.
   *
   * The first measurement and every change after it both land here. Before it,
   * the work area is 0x0 and every window is left where storage put it; that is
   * deliberate — clamping against a rectangle that has not been measured yet
   * would collapse the whole layout, and the collapse would be persisted.
   */
  setWorkArea: (rect) => {
    const state = get()
    if (!Number.isFinite(rect.x) || !Number.isFinite(rect.y)) return
    if (!(rect.width > 0) || !(rect.height > 0)) return
    if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height)) return

    const area = state.workArea
    if (
      area.x === rect.x &&
      area.y === rect.y &&
      area.width === rect.width &&
      area.height === rect.height
    ) {
      return
    }

    const floating = boundsFor('floating', area)
    set({
      workArea: rect,
      windows: state.windows.map((win) => refit(win, win.mode === 'docked' ? rect : floating))
    })
  },

  /** Back to the layout the app starts with. The way out of a lost window. */
  resetLayout: () => {
    const { workArea } = get()
    const floating = boundsFor('floating', workArea)
    set({
      windows: WINDOW_DEFS.map((def, index) =>
        refit(
          { ...defaultWindow(def), zIndex: index + 1 },
          def.mode === 'docked' ? workArea : floating
        )
      ),
      topZ: WINDOW_DEFS.length
    })
    persistWindowLayout()
  },

  /**
   * Put every window where a preset says, in one go.
   *
   * The whole stack at once rather than window by window: a preset is a complete
   * arrangement, and applying it in pieces would show whoever picked it two
   * layouts they never asked for on the way through.
   *
   * Nothing happens before the workspace has been measured. The slots are
   * fractions of it, so an unmeasured one would put every window at the origin
   * at its minimum size — and then write that down, which is exactly the corner
   * `setWorkArea` refuses to fall into for the same reason.
   */
  applyLayout: (id) => {
    const preset = LAYOUT_PRESETS.find((item) => item.id === id)
    if (preset === undefined) return

    set((state) => {
      const area = state.workArea
      if (!(area.width > 0) || !(area.height > 0)) return state

      return {
        windows: state.windows.map((win, index) => {
          const slot = preset.slots[win.id]
          const rect = slotRect(slot, area)
          return refit(
            {
              ...win,
              mode: 'docked',
              closed: !slot.open,
              minimized: false,
              alwaysOnTop: false,
              position: { x: rect.x, y: rect.y },
              size: { width: rect.width, height: rect.height },
              // Back to the stacking the windows are declared in — the rack
              // behind the timeline, the roll in front of both — so that picking
              // the same layout twice, or two layouts in a row, is the same
              // picture rather than one that remembers what was focused last.
              zIndex: index + 1
            },
            area
          )
        }),
        topZ: state.windows.length
      }
    })
    persistWindowLayout()
  }
}))
