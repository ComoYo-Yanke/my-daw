import { useEffect, useRef, useState } from 'react'
import { useDawStore } from '../state/useDawStore'

/** Path's last segment. The renderer has no `path` module and has no use for one. */
function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

/** One row of the menu. */
type MenuItem = {
  label: string
  /** Shown at the far end of the row, for the ones that have a key. */
  keys?: string
  run: () => Promise<void>
}

/**
 * The 文件 menu, and the name of the project it acts on.
 *
 * The name sits next to the button because it is what makes 保存 and 另存为 mean
 * different things: with a file behind the project, 保存 writes over it, and
 * without one it has to ask. Showing which it is takes the guesswork out of
 * pressing it.
 */
function FileMenu(): React.JSX.Element {
  const newProject = useDawStore((state) => state.newProject)
  const openProject = useDawStore((state) => state.openProject)
  const saveProject = useDawStore((state) => state.saveProject)
  const saveProjectAs = useDawStore((state) => state.saveProjectAs)
  const projectPath = useDawStore((state) => state.projectPath)
  const isDirty = useDawStore((state) => state.isDirty)

  const [open, setOpen] = useState(false)
  /**
   * Whether a menu action is still running.
   *
   * These open system dialogs, so they take as long as the user takes. Without
   * this, a second click lands while the first dialog is still up and queues
   * another one behind it.
   */
  const [busy, setBusy] = useState(false)
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

  const items: MenuItem[] = [
    { label: '新建', run: newProject },
    { label: '打开…', keys: 'Ctrl+O', run: openProject },
    { label: '保存', keys: 'Ctrl+S', run: saveProject },
    { label: '另存为…', run: saveProjectAs }
  ]

  /**
   * Close first, then run.
   *
   * The dialogs these open take focus away from the window, so the menu has to
   * be gone before that happens rather than sitting open behind a modal.
   */
  const run = async (item: MenuItem): Promise<void> => {
    setOpen(false)
    setBusy(true)
    try {
      await item.run()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="file-menu" ref={menuRef}>
      <button
        type="button"
        className="toolbar__button"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy}
        onClick={() => setOpen((shown) => !shown)}
      >
        文件
      </button>

      <span className="toolbar__project" title={projectPath ?? '这个工程还没有保存过'}>
        {projectPath === null ? '未命名' : fileName(projectPath)}
        {/* The star editors put in the title bar: there is something to save. */}
        {isDirty ? ' •' : ''}
      </span>

      {open && (
        <div className="file-menu__list" role="menu">
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className="file-menu__item"
              disabled={busy}
              onClick={() => void run(item)}
            >
              <span>{item.label}</span>
              {item.keys !== undefined && <span className="file-menu__keys">{item.keys}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export default FileMenu
