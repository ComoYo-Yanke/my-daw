import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { LIBRARY } from '../audio/library'
import {
  ROOT_CATEGORY_LABEL,
  useDawStore,
  type Channel,
  type UserSample
} from '../state/useDawStore'

/** One category of the user's own samples, flattened for drawing. */
type UserCategory = {
  id: string
  label: string
  samples: UserSample[]
}

type SamplePickerProps = {
  /**
   * The channels the swap can be aimed at, in rack order.
   *
   * Never empty: a pattern that uses no channels has its menu row disabled, and a
   * channel's own row always has itself. One entry means no selector is drawn —
   * there is nothing to choose between.
   */
  channels: Channel[]
  /** One line saying what the swap is being made for, and what it will affect. */
  context: string
  onClose: () => void
}

/**
 * Pick the sample a channel plays.
 *
 * A list rather than a submenu, because what a submenu would hold is the whole
 * library: two levels of categories and a folder of the user's own files, which
 * is a dialog's worth of content and not a menu's.
 *
 * A click replaces the sample immediately and the dialog stays open, which is the
 * only arrangement that makes browsing worth doing — you hear each candidate over
 * the part you are working on, and the one you leave selected is the one you want.
 * Closing is therefore the confirmation, not a button press.
 *
 * The list is flat inside each category: an entry is a sound, and the library's
 * own names ("808 Kick", "Closed Hat") already say which sound it is, so the
 * group headings the sidebar draws would be a second label on the same thing.
 */
function SamplePicker({ channels, context, onClose }: SamplePickerProps): React.JSX.Element {
  const samples = useDawStore((state) => state.samples)
  const userSamples = useDawStore((state) => state.userSamples)
  const userSampleFolder = useDawStore((state) => state.userSampleFolder)
  const replaceChannelSample = useDawStore((state) => state.replaceChannelSample)
  const replaceChannelSampleFromFile = useDawStore((state) => state.replaceChannelSampleFromFile)

  /** Which channel is being changed. The first one, until another is picked. */
  const [channelId, setChannelId] = useState(channels[0].id)

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  /**
   * The folder's contents, grouped by the subfolder each file came from.
   *
   * The same shape the sidebar draws, and derived the same way: the scan gives a
   * flat list, and the grouping is only ever about how it is shown.
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
    return [...byCategory.entries()].map(([category, found]) => ({
      id: `user:${category}`,
      label: category === '' ? ROOT_CATEGORY_LABEL : category,
      samples: found
    }))
  }, [userSamples])

  // Resolved rather than held, so what the list marks is read from the store on
  // every render: the sample a channel plays is the store's answer, never this
  // panel's memory of what it last clicked.
  const channel = channels.find((item) => item.id === channelId) ?? channels[0]
  const currentPath = samples.find((sample) => sample.id === channel.sampleId)?.path

  const choose = (path: string): void => void replaceChannelSample(channel.id, path)

  /**
   * One entry of the list.
   *
   * Marked rather than merely clickable, because the list's whole job is to show
   * what is playing and what else could be: a click changes it, so "which one is
   * on" has to be readable at all times.
   */
  const chip = (path: string, name: string): React.JSX.Element => (
    <button
      key={path}
      type="button"
      className="picker__chip"
      data-current={path === currentPath}
      onClick={() => choose(path)}
      title={path}
    >
      {name}
    </button>
  )

  // Portalled to the body for the reason `ContextMenu` is: this is opened from a
  // window, and a window is a positioned box with a z-index of its own, so a
  // dialog left inside one would be ordered against that window's contents and
  // covered by whatever window is stacked above it.
  return createPortal(
    <div
      className="confirm"
      role="dialog"
      aria-modal="true"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="confirm__box picker">
        <h2 className="picker__title">更换音色</h2>
        <p className="picker__hint">{context}</p>

        {channels.length > 1 && (
          <label className="picker__row">
            <span className="picker__label">通道</span>
            <select
              className="picker__input"
              value={channel.id}
              onChange={(event) => setChannelId(event.target.value)}
            >
              {channels.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
        )}

        <div className="picker__list">
          <span className="picker__section">内置库</span>

          {LIBRARY.map((category) => (
            <div key={category.id} className="picker__group">
              <span className="picker__group-label">{category.label}</span>
              <div className="picker__chips">
                {category.groups.flatMap((group) =>
                  group.samples.map((sample) => chip(sample.path, sample.name))
                )}
              </div>
            </div>
          ))}

          <span className="picker__section">我的文件夹</span>

          {userCategories.length === 0 ? (
            <p className="picker__empty">
              {userSampleFolder === null
                ? '还没有选择采样目录。在「采样库」里选一个，里面的采样会出现在这里。'
                : '这个目录里没有能读的音频文件。'}
            </p>
          ) : (
            userCategories.map((category) => (
              <div key={category.id} className="picker__group">
                <span className="picker__group-label">{category.label}</span>
                <div className="picker__chips">
                  {category.samples.map((sample) => chip(sample.path, sample.name))}
                </div>
              </div>
            ))
          )}
        </div>

        <div className="confirm__actions">
          <button
            type="button"
            className="confirm__button"
            onClick={() => void replaceChannelSampleFromFile(channel.id)}
            title="从磁盘选一个音频文件；选了多个时只取第一个"
          >
            导入采样…
          </button>
          <button type="button" className="confirm__button" onClick={onClose} autoFocus>
            关闭
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

export default SamplePicker
