import { useMemo, useState } from 'react'
import { LIBRARY } from '../audio/library'
import { ROOT_CATEGORY_LABEL, useDawStore, type UserSample } from '../state/useDawStore'

/** One category of the user's own samples, flattened for drawing. */
type UserCategory = {
  id: string
  label: string
  samples: UserSample[]
}

/**
 * The sample library, as a sidebar down the left of the rack.
 *
 * Two trees in one panel. The built-in one is `LIBRARY` itself — sounds
 * synthesised from a path, so clicking an entry builds a channel with no file
 * involved. The other is whatever the user pointed the app at: real audio files,
 * read off disk and decoded when they are clicked.
 *
 * The two are drawn differently on purpose even though they look alike. A
 * library sample always builds; a folder sample can fail, because a file can be
 * moved between the scan and the click, and the store reports that in the error
 * banner rather than pretending the click did nothing.
 *
 * Unfolding is held as the *closed* set rather than the open one. A category
 * nobody has touched then starts open, which is what the user's own folders
 * want — pointing the library at a folder is how you ask to see inside it. The
 * built-in tree is the other way round, so everything but Drums is listed as
 * closed to begin with, derived rather than spelled out.
 */
function SampleBrowser(): React.JSX.Element {
  const addLibrarySample = useDawStore((state) => state.addLibrarySample)
  const addUserSample = useDawStore((state) => state.addUserSample)
  const userSamples = useDawStore((state) => state.userSamples)
  const userSampleFolder = useDawStore((state) => state.userSampleFolder)
  const isScanningSamples = useDawStore((state) => state.isScanningSamples)
  const pickUserSampleFolder = useDawStore((state) => state.pickUserSampleFolder)
  const refreshUserSamples = useDawStore((state) => state.refreshUserSamples)

  const [collapsed, setCollapsed] = useState<string[]>(() =>
    LIBRARY.filter((category) => category.id !== 'drums').map((category) => category.id)
  )

  const toggleCategory = (categoryId: string): void => {
    setCollapsed((ids) =>
      ids.includes(categoryId) ? ids.filter((id) => id !== categoryId) : [...ids, categoryId]
    )
  }

  /**
   * The folder's contents, grouped by the subfolder each file came from.
   *
   * The category names come from the scan, which is why this is derived here
   * rather than kept in the store: the store holds the flat list, and the
   * grouping is only ever about how it is drawn.
   */
  const userCategories = useMemo<UserCategory[]>(() => {
    const byCategory = new Map<string, UserSample[]>()
    for (const sample of userSamples) {
      const group = byCategory.get(sample.category)
      if (group) {
        group.push(sample)
      } else {
        byCategory.set(sample.category, [sample])
      }
    }
    return [...byCategory.entries()].map(([category, samples]) => ({
      id: `user:${category}`,
      label: category === '' ? ROOT_CATEGORY_LABEL : category,
      samples
    }))
  }, [userSamples])

  return (
    <aside className="library" aria-label="采样库">
      <div className="library__folder">
        <button
          type="button"
          className="library__folder-button"
          onClick={() => void pickUserSampleFolder()}
          title={userSampleFolder ?? '挑一个装着 wav 的文件夹，里面的采样会出现在下面'}
        >
          {userSampleFolder === null ? '选择采样目录' : '换一个目录'}
        </button>
        {userSampleFolder !== null && (
          <button
            type="button"
            className="library__folder-button library__folder-button--slim"
            onClick={() => void refreshUserSamples()}
            disabled={isScanningSamples}
            title="重新扫描目录，读进新加进去的文件"
          >
            {isScanningSamples ? '扫描中…' : '刷新'}
          </button>
        )}
      </div>

      {/* Which folder is being read. The last segment only — a full path does not
          fit a sidebar, and the part that says which folder it is is the end of
          it. The whole thing is on the button's tooltip. */}
      {userSampleFolder !== null && (
        <p className="library__folder-path" title={userSampleFolder}>
          {userSampleFolder.split(/[\\/]/).filter(Boolean).pop() ?? userSampleFolder}
        </p>
      )}

      <div className="library__tree">
        {userSampleFolder !== null && userCategories.length === 0 && (
          <p className="library__empty">
            {isScanningSamples ? '正在扫描…' : '这个目录里没有能读的音频文件。'}
          </p>
        )}

        {userCategories.map((category) => {
          const isOpen = !collapsed.includes(category.id)
          return (
            <div key={category.id} className="library__category">
              <button
                type="button"
                className="library__category-button library__category-button--user"
                aria-expanded={isOpen}
                onClick={() => toggleCategory(category.id)}
              >
                <span className="library__arrow" aria-hidden="true">
                  {isOpen ? '▾' : '▸'}
                </span>
                {category.label}
              </button>

              {isOpen && (
                <div className="library__group library__group--flat">
                  {category.samples.map((sample) => (
                    <button
                      key={sample.path}
                      type="button"
                      className="library__sample"
                      onClick={() => void addUserSample(sample.path)}
                      title={`添加 ${sample.name}：从磁盘读进来并在机架上建一个通道`}
                    >
                      {sample.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )
        })}

        {LIBRARY.map((category) => {
          const isOpen = !collapsed.includes(category.id)
          return (
            <div key={category.id} className="library__category">
              <button
                type="button"
                className="library__category-button"
                aria-expanded={isOpen}
                onClick={() => toggleCategory(category.id)}
              >
                <span className="library__arrow" aria-hidden="true">
                  {isOpen ? '▾' : '▸'}
                </span>
                {category.label}
              </button>

              {isOpen &&
                category.groups.map((group) => (
                  <div
                    key={group.id}
                    /* Only the flat categories — guitar, piano — have no group
                       heading to sit under, so their entries come back in a level. */
                    className={
                      group.label === '' ? 'library__group library__group--flat' : 'library__group'
                    }
                  >
                    {group.label !== '' && (
                      <span className="library__group-label">{group.label}</span>
                    )}
                    {group.samples.map((sample) => (
                      <button
                        key={sample.path}
                        type="button"
                        className="library__sample"
                        onClick={() => void addLibrarySample(sample.path)}
                        title={`添加 ${sample.name}：在机架上建一个通道并试听`}
                      >
                        {sample.name}
                      </button>
                    ))}
                  </div>
                ))}
            </div>
          )
        })}
      </div>
    </aside>
  )
}

export default SampleBrowser
