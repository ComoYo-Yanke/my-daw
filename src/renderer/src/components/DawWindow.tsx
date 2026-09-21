import { useEffect, useRef } from 'react'
import {
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  persistWindowLayout,
  selectWindowZ,
  TITLEBAR_HEIGHT_PX,
  useWindowStore,
  type Rect,
  type WindowId
} from '../state/useWindowStore'

/** Which side is being dragged. The corners are two sides at once. */
type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

const EDGES: Edge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']

/** An in-flight drag, measured from where the pointer went down. */
type Gesture = {
  kind: 'move' | 'resize'
  edge: Edge | null
  pointerX: number
  pointerY: number
  from: Rect
}

type DawWindowProps = {
  id: WindowId
  /**
   * A longer name than the store's, for a window whose contents change.
   *
   * The piano roll shows which channel it is editing, which the window menu has
   * no way to know; the store keeps the plain name for the menu.
   */
  title?: string
  /**
   * What the × does, when closing the window is not all that closing it means.
   *
   * The piano roll and the library both have a switch in `useDawStore` that has
   * to be turned off with the window, or the two would disagree about whether
   * the thing is open.
   */
  onRequestClose?: () => void
  children: React.ReactNode
}

/**
 * One panel, as a window.
 *
 * Docked and floating are the same box drawn in the same place; the mode is a
 * clamping policy and a frame, not a different kind of element. Everything the
 * window knows about geometry lives in `useWindowStore`, so this is a box that
 * draws what it is told and reports the drags it was given.
 *
 * `children` is passed in by `App`, and that is deliberate: this component
 * re-renders on every frame of a drag, and if it built its own contents they
 * would be rebuilt with it. Handed in from above, they keep their identity and
 * React skips the whole subtree.
 */
function DawWindow({
  id,
  title,
  onRequestClose,
  children
}: DawWindowProps): React.JSX.Element | null {
  const win = useWindowStore((state) => state.windows.find((item) => item.id === id))
  // A number, not the array it came from: zustand compares with `Object.is`, and
  // a selector that builds a new array every time never compares equal.
  const z = useWindowStore((state) => selectWindowZ(state.windows, id))
  const focusWindow = useWindowStore((state) => state.focusWindow)
  const closeWindow = useWindowStore((state) => state.closeWindow)
  const minimizeWindow = useWindowStore((state) => state.minimizeWindow)
  const toggleMode = useWindowStore((state) => state.toggleMode)
  const toggleAlwaysOnTop = useWindowStore((state) => state.toggleAlwaysOnTop)
  const setGeometry = useWindowStore((state) => state.setGeometry)

  const gestureRef = useRef<Gesture | null>(null)

  /**
   * Drags are tracked on the window, so the pointer is free to leave the handle
   * — off the window, or off the app entirely.
   *
   * Every position is measured from where the gesture started rather than added
   * up move by move, for the same reason the playlist's drags are: a drag that
   * wanders and comes back lands exactly where it began. The dependencies are
   * both stable, so this registers once rather than on every frame.
   */
  useEffect(() => {
    const handlePointerMove = (event: PointerEvent): void => {
      const gesture = gestureRef.current
      if (gesture === null) return

      const dx = event.clientX - gesture.pointerX
      const dy = event.clientY - gesture.pointerY
      const { from } = gesture

      if (gesture.kind === 'move') {
        setGeometry(id, { x: from.x + dx, y: from.y + dy })
        return
      }

      const edge = gesture.edge ?? 'se'
      const west = edge.includes('w')
      const east = edge.includes('e')
      const north = edge.includes('n')
      const south = edge.includes('s')

      // The size is clamped here and the far edge is then derived from it, so
      // that dragging the left edge in past the minimum stops that edge instead
      // of sliding the whole window sideways. The store clamps against the
      // workspace afterwards; these are the two different limits.
      const width = Math.max(MIN_WINDOW_WIDTH, from.width + (east ? dx : west ? -dx : 0))
      const height = Math.max(MIN_WINDOW_HEIGHT, from.height + (south ? dy : north ? -dy : 0))

      setGeometry(id, {
        x: west ? from.x + from.width - width : from.x,
        y: north ? from.y + from.height - height : from.y,
        width,
        height
      })
    }

    const handlePointerUp = (): void => {
      // Written once, on release: the layout that matters is the one the drag
      // ended on, and a drag would otherwise write on every frame of it.
      if (gestureRef.current !== null) persistWindowLayout()
      gestureRef.current = null
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerUp)
    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerUp)
    }
  }, [id, setGeometry])

  // All of this component's hooks are above this line, so a closed window is a
  // window that draws nothing rather than one that renders in a different shape.
  if (win === undefined || win.closed) return null

  const startGesture = (
    event: React.PointerEvent,
    kind: Gesture['kind'],
    edge: Edge | null
  ): void => {
    if (event.button !== 0) return
    // The content below has drags of its own — clips, notes, the grid itself —
    // and none of them should start behind a grab on the frame.
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    gestureRef.current = {
      kind,
      edge,
      pointerX: event.clientX,
      pointerY: event.clientY,
      from: { ...win.position, ...win.size }
    }
  }

  const handleBarPointerDown = (event: React.PointerEvent): void => {
    // The bar's own buttons share the bar with the drag, and pressing one of
    // them is not a press on the title bar.
    if ((event.target as HTMLElement).closest('button') !== null) return
    startGesture(event, 'move', null)
  }

  return (
    <section
      className="daw-window"
      data-mode={win.mode}
      data-minimized={win.minimized}
      aria-label={title ?? win.title}
      // A press anywhere inside brings the window forward, before the content
      // gets to see it: the thing you pressed belongs to the window you pressed.
      onPointerDownCapture={() => focusWindow(id)}
      style={{
        left: `${win.position.x}px`,
        top: `${win.position.y}px`,
        width: `${win.size.width}px`,
        // Inline, so it beats the rule in the stylesheet: a minimized window is
        // exactly its title bar, and its stored height is waiting for it.
        height: `${win.minimized ? TITLEBAR_HEIGHT_PX : win.size.height}px`,
        zIndex: z
      }}
    >
      <header className="daw-window__bar" onPointerDown={handleBarPointerDown}>
        <span className="daw-window__title">{title ?? win.title}</span>

        <button
          type="button"
          className="daw-window__button"
          aria-pressed={win.alwaysOnTop}
          onClick={() => toggleAlwaysOnTop(id)}
          title={win.alwaysOnTop ? '取消始终置顶' : '始终置顶'}
          aria-label={win.alwaysOnTop ? '取消始终置顶' : '始终置顶'}
        >
          📌
        </button>

        <button
          type="button"
          className="daw-window__button daw-window__button--mode"
          onClick={() => toggleMode(id)}
          title={win.mode === 'docked' ? '浮出工作区，可以盖住其它面板' : '停靠回工作区'}
        >
          {win.mode === 'docked' ? '浮动' : '停靠'}
        </button>

        <button
          type="button"
          className="daw-window__button"
          onClick={() => minimizeWindow(id)}
          title={win.minimized ? '展开' : '收起'}
          aria-label={win.minimized ? '展开' : '收起'}
        >
          ▁
        </button>

        <button
          type="button"
          className="daw-window__button daw-window__button--close"
          onClick={onRequestClose ?? (() => closeWindow(id))}
          title="关闭窗口"
          aria-label="关闭窗口"
        >
          ×
        </button>
      </header>

      {/* Unmounted rather than hidden: a window that is a title bar has no body,
          and a hidden one would still be measured as zero. */}
      {!win.minimized && <div className="daw-window__body">{children}</div>}

      {!win.minimized &&
        EDGES.map((edge) => (
          <span
            key={edge}
            className="daw-window__resize"
            data-edge={edge}
            onPointerDown={(event) => startGesture(event, 'resize', edge)}
          />
        ))}
    </section>
  )
}

export default DawWindow
