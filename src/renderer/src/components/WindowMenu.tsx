import { useEffect, useRef, useState } from 'react'
import { useDawStore } from '../state/useDawStore'
import {
  selectWindowOpen,
  useWindowStore,
  windowTitle,
  type WindowId
} from '../state/useWindowStore'

/** Whether a window is showing, as a stable boolean for the selector's sake. */
function useOpen(id: WindowId): boolean {
  return useWindowStore((state) => selectWindowOpen(state.windows, id))
}

/** One row: a window, and what picking it does. */
type Entry = {
  id: WindowId
  label: string
  open: boolean
  /** Greyed out when there is nothing for the window to show. */
  disabled: boolean
  run: () => void
}

/**
 * The 窗口 menu: the way back to a window that has been closed.
 *
 * A window's × is one-way — it closes the window and the frame it was in goes
 * with it — so without a list somewhere the panels would be reachable only by
 * the gestures that happen to open them.
 *
 * Built like the 文件 menu rather than with `ContextMenu`: it is anchored to its
 * own button, which has to be able to close it, and `ContextMenu`'s dismissal
 * runs in the capture phase and does not cover its trigger.
 */
function WindowMenu(): React.JSX.Element {
  const channels = useDawStore((state) => state.channels)
  const pianoRollChannelId = useDawStore((state) => state.pianoRollChannelId)
  const openPianoRoll = useDawStore((state) => state.openPianoRoll)
  const closePianoRoll = useDawStore((state) => state.closePianoRoll)

  const toggleWindow = useWindowStore((state) => state.toggleWindow)
  const resetLayout = useWindowStore((state) => state.resetLayout)

  const rackOpen = useOpen('channel-rack')
  const rollOpen = useOpen('piano-roll')
  const listOpen = useOpen('playlist')
  const libraryOpen = useOpen('sample-browser')

  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  // Only while the menu is open: a click anywhere else closes it.
  useEffect(() => {
    if (!open) return

    const handlePointerDown = (event: PointerEvent): void => {
      if (menuRef.current?.contains(event.target as Node) !== true) setOpen(false)
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }

    window.addEventListener('pointerdown', handlePointerDown)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  /**
   * What picking the piano roll does.
   *
   * Not `toggleWindow`: an open roll is a roll bound to a channel, and the
   * binding is what the transport and the ▶ button go by. Closing the window has
   * to drop it — the same thing the window's own × does — so opening it again
   * binds to the channel that was open, or to the first one there is.
   */
  const toggleRoll = (): void => {
    if (rollOpen) {
      closePianoRoll()
      return
    }
    const channelId = pianoRollChannelId ?? channels[0]?.id
    if (channelId !== undefined) openPianoRoll(channelId)
  }

  const entries: Entry[] = [
    {
      id: 'channel-rack',
      label: windowTitle('channel-rack'),
      open: rackOpen,
      disabled: false,
      run: () => toggleWindow('channel-rack')
    },
    {
      id: 'piano-roll',
      label: windowTitle('piano-roll'),
      open: rollOpen,
      disabled: !rollOpen && channels.length === 0,
      run: toggleRoll
    },
    {
      id: 'playlist',
      label: windowTitle('playlist'),
      open: listOpen,
      disabled: false,
      run: () => toggleWindow('playlist')
    },
    {
      id: 'sample-browser',
      label: windowTitle('sample-browser'),
      open: libraryOpen,
      disabled: false,
      run: () => toggleWindow('sample-browser')
    }
  ]

  return (
    <div className="file-menu" ref={menuRef}>
      <button
        type="button"
        className="toolbar__button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((shown) => !shown)}
      >
        窗口
      </button>

      {open && (
        <div className="file-menu__list" role="menu">
          {entries.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="menuitemcheckbox"
              aria-checked={entry.open}
              className="file-menu__item"
              disabled={entry.disabled}
              title={entry.disabled ? '先在 Channel Rack 里建一个通道' : undefined}
              onClick={() => entry.run()}
            >
              <span>{entry.label}</span>
              {/* The tick sits where a shortcut would, so the rows line up. */}
              <span className="file-menu__check">{entry.open ? '✓' : ''}</span>
            </button>
          ))}

          {/* Closing the menu first: the layout is about to change under it. */}
          <button
            type="button"
            role="menuitem"
            className="file-menu__item file-menu__item--split"
            onClick={() => {
              setOpen(false)
              resetLayout()
            }}
            title="把所有窗口放回它们一开始的位置"
          >
            <span>重置窗口布局</span>
          </button>
        </div>
      )}
    </div>
  )
}

export default WindowMenu
