import { useState } from 'react'
import ConfirmDialog from './ConfirmDialog'
import ContextMenu, { type ContextMenuItem } from './ContextMenu'
import { useDawStore } from '../state/useDawStore'

/** Where a right-click opened a menu, and which tab it was on. */
type Menu = { patternId: string; x: number; y: number }

/** A deletion waiting on an answer, and what has to be said about it. */
type Pending = { patternId: string; name: string; clips: number }

/**
 * The pattern switcher above the rack.
 *
 * Tabs rather than a dropdown, so the same interaction the channel names use —
 * click to switch, double-click to rename — works here too. What a tab cannot
 * show is everything else that can be done to a pattern, which is what the
 * right-click menu is for.
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
  const playMode = useDawStore((state) => state.playMode)
  const setPlayMode = useDawStore((state) => state.setPlayMode)

  /** Non-null while a tab's name is being edited. */
  const [draft, setDraft] = useState<{ id: string; name: string } | null>(null)
  /** The open right-click menu, or null. */
  const [menu, setMenu] = useState<Menu | null>(null)
  /** A deletion that has to be confirmed first, or null. */
  const [pending, setPending] = useState<Pending | null>(null)

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

  const menuItems = (patternId: string, name: string): ContextMenuItem[] => [
    { label: '重命名', run: () => setDraft({ id: patternId, name }) },
    { label: '复制', run: () => duplicatePattern(patternId) },
    {
      label: '删除',
      danger: true,
      disabled: patterns.length <= 1,
      run: () => askDelete(patternId, name)
    }
  ]

  // Resolved from the id rather than held in the menu: a pattern can go away
  // while its menu is open, and a menu for something that is gone has nothing
  // to act on.
  const menuPattern =
    menu === null ? undefined : patterns.find((item) => item.id === menu.patternId)

  return (
    <div className="pattern-bar">
      <div className="mode-switch" role="group" aria-label="模式">
        {(['pattern', 'song'] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            className="mode-switch__option"
            aria-pressed={playMode === mode}
            onClick={() => setPlayMode(mode)}
            title={mode === 'pattern' ? '编辑单个 Pattern' : '在时间线上编排 Pattern'}
          >
            {mode === 'pattern' ? 'Pattern' : 'Song'}
          </button>
        ))}
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
          items={menuItems(menuPattern.id, menuPattern.name)}
          onClose={() => setMenu(null)}
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
