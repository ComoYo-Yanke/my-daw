import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/** One row of the menu. */
export type ContextMenuItem = {
  label: string
  /** Runs when the row is picked. The menu is already closed by then. */
  run: () => void
  /** Greyed out and unpickable, for an action that would not be legal here. */
  disabled?: boolean
  /** Marks a row that throws something away, so it reads as the dangerous one. */
  danger?: boolean
}

type ContextMenuProps = {
  /** Where the press landed, in client coordinates. */
  x: number
  y: number
  items: ContextMenuItem[]
  onClose: () => void
}

/** How far the menu keeps off the window's edges, in pixels. */
const EDGE_PX = 8

/**
 * A popup menu at a point.
 *
 * Placed at the pointer rather than anchored to whatever was right-clicked,
 * because what it acts on is the thing the press landed on, and that thing may
 * be a whole row with no obvious corner to hang a menu from.
 *
 * The position is settled after the first layout pass, when the menu's own size
 * is known, so one opened near the bottom or right edge of the window is nudged
 * back inside it rather than hanging off. That happens before the first paint,
 * so it is never seen in the wrong place.
 */
function ContextMenu({ x, y, items, onClose }: ContextMenuProps): React.JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null)
  /** Where it ends up being drawn, once its size is known. */
  const [at, setAt] = useState({ x, y })

  useLayoutEffect(() => {
    const element = menuRef.current
    if (element === null) return
    const { width, height } = element.getBoundingClientRect()
    setAt({
      x: Math.max(EDGE_PX, Math.min(x, window.innerWidth - width - EDGE_PX)),
      y: Math.max(EDGE_PX, Math.min(y, window.innerHeight - height - EDGE_PX))
    })
  }, [x, y])

  /**
   * Dismissal is watched on the window, and in the capture phase.
   *
   * Capture because a press on another row's button has to do both things: close
   * this menu, and be the button's own click. Letting the menu's dismissal run
   * first is what keeps the two from being one gesture instead of two.
   */
  useEffect(() => {
    const handlePointerDown = (event: PointerEvent): void => {
      if (menuRef.current?.contains(event.target as Node) !== true) onClose()
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }

    window.addEventListener('pointerdown', handlePointerDown, true)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown, true)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [onClose])

  // Portalled to the body rather than drawn where it was opened.
  //
  // A menu is opened from a window, and a window is a positioned box with a
  // z-index of its own — which makes it a stacking context. Left inside one, the
  // menu's own z-index would only order it against that window's contents, and
  // any window stacked above would cover it: pin the sample library and the rack
  // rows' right-click menu disappears behind it. Dismissal is unaffected, since
  // it asks whether the menu's own element contains the press.
  return createPortal(
    <div
      className="ctx-menu"
      role="menu"
      ref={menuRef}
      style={{ left: `${at.x}px`, top: `${at.y}px` }}
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          className="ctx-menu__item"
          data-danger={item.danger === true}
          disabled={item.disabled === true}
          onClick={() => {
            // Closed first: an item that opens a dialog must not leave the menu
            // sitting behind it.
            onClose()
            item.run()
          }}
        >
          {item.label}
        </button>
      ))}
    </div>,
    document.body
  )
}

export default ContextMenu
