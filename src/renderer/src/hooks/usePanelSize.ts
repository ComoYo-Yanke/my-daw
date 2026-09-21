import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * A panel's size in pixels.
 *
 * `width` may be null, meaning "not pinned": the panel takes whatever width its
 * container hands it. That is how one starts out — only a horizontal drag turns
 * it into a number, so a panel nobody has resized still follows the window.
 */
export type PanelSize = { width: number | null; height: number }

/** Which edge is being dragged. `corner` is the bottom-right one, both at once. */
export type ResizeEdge = 'top' | 'left' | 'right' | 'corner'

/** Keep a size at or above the minimum, in whole pixels. Null width stays null. */
function clampSize(size: PanelSize, minWidth: number, minHeight: number): PanelSize {
  return {
    width: size.width === null ? null : Math.max(minWidth, Math.round(size.width)),
    height: Math.max(minHeight, Math.round(size.height))
  }
}

/**
 * The size stored under a key, or null when there is nothing usable there.
 *
 * Anything unexpected — no entry, unparseable JSON, a missing or non-finite
 * field, storage that is disabled or full — reads as "nothing stored", which
 * puts the panel back on its default rather than onto NaN.
 */
function readStored(key: string, minWidth: number, minHeight: number): PanelSize | null {
  try {
    const raw = window.localStorage.getItem(key)
    if (raw === null) return null

    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null

    const { width, height } = parsed as Partial<PanelSize>
    if (width !== null && (typeof width !== 'number' || !Number.isFinite(width))) return null
    if (typeof height !== 'number' || !Number.isFinite(height)) return null

    return clampSize({ width: width ?? null, height }, minWidth, minHeight)
  } catch {
    return null
  }
}

/** Remember a size. A storage that refuses it costs the setting, not the resize. */
function writeStored(key: string, size: PanelSize): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(size))
  } catch {
    // Full, or disabled. The panel still moves; it just forgets by next launch.
  }
}

/**
 * A panel size the user can drag, remembered between launches.
 *
 * Remembered in `localStorage` rather than in the project, because it is a
 * property of the workspace and not of the music: how wide the piano roll was
 * left is not something to carry into a file, or to have Ctrl+Z undo.
 *
 * Every edge here is measured against a panel anchored to the bottom right of
 * the window, which is what makes the signs what they are: growing upward means
 * the pointer travelling up, so the vertical delta is subtracted; growing
 * leftward means it travelling left, so the left edge's is too.
 */
export function usePanelSize(
  key: string,
  elementRef: React.RefObject<HTMLElement | null>,
  defaultSize: PanelSize,
  minWidth: number,
  minHeight: number
): { size: PanelSize; beginResize: (edge: ResizeEdge, event: React.PointerEvent) => void } {
  const [size, setSize] = useState<PanelSize>(
    () => readStored(key, minWidth, minHeight) ?? clampSize(defaultSize, minWidth, minHeight)
  )

  /** The size as of the last change, for the write on release. */
  const sizeRef = useRef(size)

  const applySize = useCallback((next: PanelSize): void => {
    sizeRef.current = next
    setSize(next)
  }, [])

  /**
   * The size and pointer position the drag started from.
   *
   * Held in a ref and measured from at every move rather than accumulated, for
   * the same reason the grid's own drags are: a drag that wanders and comes back
   * lands exactly where it started, and the panel never chases its own rounding.
   */
  const dragRef = useRef<{
    edge: ResizeEdge
    pointerX: number
    pointerY: number
    from: PanelSize
  } | null>(null)

  const beginResize = useCallback(
    (edge: ResizeEdge, event: React.PointerEvent): void => {
      if (event.button !== 0) return
      // The handle sits over the panel's own content, which has drags of its
      // own: without this the grid would start one behind the grab.
      event.preventDefault()
      event.stopPropagation()

      // A panel nobody has resized yet has no width of its own to count from, so
      // the one it is currently taking up is measured.
      const from: PanelSize = {
        width: size.width ?? elementRef.current?.getBoundingClientRect().width ?? minWidth,
        height: size.height
      }

      dragRef.current = { edge, pointerX: event.clientX, pointerY: event.clientY, from }
    },
    [size, elementRef, minWidth]
  )

  /** Drags are tracked on the window: the pointer is free to leave the handle. */
  useEffect(() => {
    const handlePointerMove = (event: PointerEvent): void => {
      const drag = dragRef.current
      if (drag === null) return

      const dx = event.clientX - drag.pointerX
      const dy = event.clientY - drag.pointerY
      const growWidth =
        drag.edge === 'left' ? -dx : drag.edge === 'right' || drag.edge === 'corner' ? dx : 0
      const growHeight = drag.edge === 'top' || drag.edge === 'corner' ? -dy : 0

      applySize(
        clampSize(
          {
            width: drag.from.width === null ? null : drag.from.width + growWidth,
            height: drag.from.height + growHeight
          },
          minWidth,
          minHeight
        )
      )
    }

    const handlePointerUp = (): void => {
      // Written once, on release: the size that matters is the one the drag ended
      // on, and a drag would otherwise write on every frame of it.
      if (dragRef.current !== null) writeStored(key, sizeRef.current)
      dragRef.current = null
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerUp)
    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerUp)
    }
  }, [applySize, key, minWidth, minHeight])

  return { size, beginResize }
}
