import { useState } from 'react'
import { useDawStore } from '../state/useDawStore'

/**
 * The pattern switcher above the rack.
 *
 * Tabs rather than a dropdown, so the same interaction the channel names use —
 * click to switch, double-click to rename — works here too.
 */
function PatternBar(): React.JSX.Element {
  const patterns = useDawStore((state) => state.patterns)
  const currentPatternId = useDawStore((state) => state.currentPatternId)
  const selectPattern = useDawStore((state) => state.selectPattern)
  const addPattern = useDawStore((state) => state.addPattern)
  const renamePattern = useDawStore((state) => state.renamePattern)
  const playMode = useDawStore((state) => state.playMode)
  const setPlayMode = useDawStore((state) => state.setPlayMode)

  /** Non-null while a tab's name is being edited. */
  const [draft, setDraft] = useState<{ id: string; name: string } | null>(null)

  const commitRename = (): void => {
    if (draft === null) return
    const name = draft.name.trim()
    if (name !== '') {
      renamePattern(draft.id, name)
    }
    setDraft(null)
  }

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
            title={
              pattern.id === currentPatternId ? '当前 Pattern（双击重命名）' : '切换到该 Pattern'
            }
          >
            {pattern.name}
          </button>
        )
      )}

      <button type="button" className="pattern-bar__add" onClick={addPattern} title="新建 Pattern">
        ＋ 新建
      </button>
    </div>
  )
}

export default PatternBar
