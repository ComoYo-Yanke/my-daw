import { useState } from 'react'
import { LIBRARY } from '../audio/library'
import { useDawStore } from '../state/useDawStore'

/**
 * The built-in sample library, as a sidebar down the left of the rack.
 *
 * The tree it draws is `LIBRARY` itself — the only thing worth keeping in state
 * is which categories are unfolded. Clicking an entry builds a channel straight
 * away, with no file dialog in between, because there is no file: a library
 * sample is synthesised from its path.
 */
function SampleBrowser(): React.JSX.Element {
  const addLibrarySample = useDawStore((state) => state.addLibrarySample)

  /** Unfolded category ids. Drums starts open — it is what a library is for. */
  const [expanded, setExpanded] = useState<string[]>(['drums'])

  const toggleCategory = (categoryId: string): void => {
    setExpanded((ids) =>
      ids.includes(categoryId) ? ids.filter((id) => id !== categoryId) : [...ids, categoryId]
    )
  }

  return (
    <aside className="library" aria-label="采样库">
      {/* No header of its own: the window frame around this holds the name and
          the ×, and the tree is all the panel has left to show. */}
      <div className="library__tree">
        {LIBRARY.map((category) => {
          const isOpen = expanded.includes(category.id)
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
