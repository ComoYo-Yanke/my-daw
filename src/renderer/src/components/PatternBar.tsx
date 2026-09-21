import { useState } from 'react'
import ConfirmDialog from './ConfirmDialog'
import ContextMenu, { type ContextMenuItem } from './ContextMenu'
import SamplePicker from './SamplePicker'
import { useDawStore, type Channel, type Pattern } from '../state/useDawStore'
import { selectWindowOpen, useWindowStore } from '../state/useWindowStore'
import { EMPTY_STEPS, hasSteps } from '../types/step'

/** Where a right-click opened a menu, and which tab it was on. */
type Menu = { patternId: string; x: number; y: number }

/** A deletion waiting on an answer, and what has to be said about it. */
type Pending = { patternId: string; name: string; clips: number }

/**
 * The pattern switcher above the rack, and the three window buttons beside it.
 *
 * Tabs rather than a dropdown, so the same interaction the channel names use —
 * click to switch, double-click to rename — works here too. What a tab cannot
 * show is everything else that can be done to a pattern, which is what the
 * right-click menu is for.
 *
 * The three buttons on the left are the three panels this bar sits between: the
 * rack holding the pattern's channels, the timeline arranging the patterns, and
 * the step window writing one. They are here because this is the strip that is
 * always up and the one that says which pattern everything below refers to.
 */
function PatternBar(): React.JSX.Element {
  const patterns = useDawStore((state) => state.patterns)
  const currentPatternId = useDawStore((state) => state.currentPatternId)
  const clips = useDawStore((state) => state.playlistClips)
  const selectPattern = useDawStore((state) => state.selectPattern)
  const addPattern = useDawStore((state) => state.addPattern)
  const duplicatePattern = useDawStore((state) => state.duplicatePattern)
  const removePattern = useDawStore((state) => state.removePattern)
  const renamePattern = useDawStore((state) => state.renamePattern)
  const channels = useDawStore((state) => state.channels)

  const toggleWindow = useWindowStore((state) => state.toggleWindow)
  const rackOpen = useWindowStore((state) => selectWindowOpen(state.windows, 'channel-rack'))
  const listOpen = useWindowStore((state) => selectWindowOpen(state.windows, 'playlist'))
  const stepsOpen = useWindowStore((state) => selectWindowOpen(state.windows, 'steps'))

  /** Non-null while a tab's name is being edited. */
  const [draft, setDraft] = useState<{ id: string; name: string } | null>(null)
  /** The open right-click menu, or null. */
  const [menu, setMenu] = useState<Menu | null>(null)
  /** A deletion that has to be confirmed first, or null. */
  const [pending, setPending] = useState<Pending | null>(null)
  /** The pattern whose sound picker is open, or null. */
  const [picker, setPicker] = useState<string | null>(null)

  const commitRename = (): void => {
    if (draft === null) return
    const name = draft.name.trim()
    if (name !== '') {
      renamePattern(draft.id, name)
    }
    setDraft(null)
  }

  /**
   * Delete a pattern, asking first when anything would go with it.
   *
   * A pattern the timeline places cannot be removed on its own: the clips that
   * place it would be left pointing at nothing, so they go too — and that is a
   * lot to lose to a menu row, which is why it is the one action here that asks.
   */
  const askDelete = (patternId: string, name: string): void => {
    // The menu row is disabled for this, but the answer should not depend on
    // that having been noticed.
    if (patterns.length <= 1) return

    const used = clips.filter((clip) => clip.patternId === patternId).length
    if (used === 0) {
      removePattern(patternId)
      return
    }
    setPending({ patternId, name, clips: used })
  }

  /**
   * Which channels a pattern actually plays.
   *
   * The union of the two ways a pattern can address the rack — the notes it holds
   * for a channel, and the steps it has switched on for one — because either of
   * them is the pattern using that channel, and either is a reason to want its
   * sound changed. Rack order, so the list reads the way the rack does.
   *
   * A channel whose entry is nothing but steps that are off is not listed: the
   * entry exists, but this pattern never sounds it.
   */
  const usedChannels = (pattern: Pattern): Channel[] =>
    channels.filter(
      (channel) =>
        (pattern.notesByChannel[channel.id]?.length ?? 0) > 0 ||
        hasSteps(pattern.stepsByChannel[channel.id] ?? EMPTY_STEPS, channel.stepCount)
    )

  const menuItems = (pattern: Pattern): ContextMenuItem[] => [
    { label: '重命名', run: () => setDraft({ id: pattern.id, name: pattern.name }) },
    { label: '复制', run: () => duplicatePattern(pattern.id) },
    {
      label: '更换音色…',
      // Nothing in the pattern plays a channel, so there is nothing to change
      // the sound of.
      disabled: usedChannels(pattern).length === 0,
      run: () => setPicker(pattern.id)
    },
    {
      label: '删除',
      danger: true,
      disabled: patterns.length <= 1,
      run: () => askDelete(pattern.id, pattern.name)
    }
  ]

  // Resolved from the id rather than held in the menu: a pattern can go away
  // while its menu is open, and a menu for something that is gone has nothing
  // to act on.
  const menuPattern =
    menu === null ? undefined : patterns.find((item) => item.id === menu.patternId)
  const pickerPattern = picker === null ? undefined : patterns.find((item) => item.id === picker)

  return (
    <div className="pattern-bar">
      {/* Three windows, as three buttons.
          Two of them used to be a project mode — Pattern or Song — which the
          transport keys went by. Nothing is switched any more: each button opens
          the panel it names, and Space plays to the window the mouse is in, so
          what the buttons have to say is which windows are up. */}
      <div className="window-switch" role="group" aria-label="窗口">
        <button
          type="button"
          className="toolbar__button toolbar__button--slim"
          aria-pressed={rackOpen}
          onClick={() => toggleWindow('channel-rack')}
          title="打开机架：当前 Pattern 的通道"
        >
          Pattern
        </button>
        <button
          type="button"
          className="toolbar__button toolbar__button--slim"
          aria-pressed={listOpen}
          onClick={() => toggleWindow('playlist')}
          title="打开 Song，在时间线上编排 Pattern"
        >
          Song
        </button>
        <button
          type="button"
          className="toolbar__button toolbar__button--slim"
          aria-pressed={stepsOpen}
          onClick={() => toggleWindow('steps')}
          title="打开步进窗：每个通道的步进网格、步数和 Swing"
        >
          步进
        </button>
      </div>

      <span className="pattern-bar__label">Pattern</span>

      {patterns.map((pattern) =>
        draft?.id === pattern.id ? (
          <input
            key={pattern.id}
            className="pattern__input"
            value={draft.name}
            autoFocus
            onChange={(event) => setDraft({ id: pattern.id, name: event.target.value })}
            onFocus={(event) => event.currentTarget.select()}
            onBlur={commitRename}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                commitRename()
              } else if (event.key === 'Escape') {
                setDraft(null)
              }
            }}
          />
        ) : (
          <button
            key={pattern.id}
            type="button"
            className="pattern"
            aria-pressed={pattern.id === currentPatternId}
            onClick={() => selectPattern(pattern.id)}
            onDoubleClick={() => setDraft({ id: pattern.id, name: pattern.name })}
            onContextMenu={(event) => {
              event.preventDefault()
              setMenu({ patternId: pattern.id, x: event.clientX, y: event.clientY })
            }}
            title={
              pattern.id === currentPatternId
                ? '当前 Pattern（双击重命名，右键更多操作）'
                : '切换到该 Pattern（双击重命名，右键更多操作）'
            }
          >
            {pattern.name}
            {/* How many clips on the timeline place this pattern. It is what the
                delete prompt counts, so it is worth seeing before asking. */}
            {clips.some((clip) => clip.patternId === pattern.id) && (
              <span className="pattern__used" aria-hidden="true">
                ●
              </span>
            )}
          </button>
        )
      )}

      <button type="button" className="pattern-bar__add" onClick={addPattern} title="新建 Pattern">
        ＋ 新建
      </button>

      {menu !== null && menuPattern !== undefined && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(menuPattern)}
          onClose={() => setMenu(null)}
        />
      )}

      {pickerPattern !== undefined && (
        <SamplePicker
          channels={usedChannels(pickerPattern)}
          context={`换掉 Pattern「${pickerPattern.name}」里某个通道的采样。音色是通道的属性，所以这个通道在所有 Pattern 里的音色都会跟着变；音符、步进、音量和声像都不动。`}
          onClose={() => setPicker(null)}
        />
      )}

      {pending !== null && (
        <ConfirmDialog
          text={`「${pending.name}」被时间线上的 ${pending.clips} 个 Clip 引用，删除它会把这些 Clip 一起删掉。`}
          confirmLabel="删除"
          onCancel={() => setPending(null)}
          onConfirm={() => {
            removePattern(pending.patternId)
            setPending(null)
          }}
        />
      )}
    </div>
  )
}

export default PatternBar
