import { useEffect, useLayoutEffect, useRef } from 'react'
import BpmField from './components/BpmField'
import ChannelRow from './components/ChannelRow'
import DawWindow from './components/DawWindow'
import FileMenu from './components/FileMenu'
import PatternBar from './components/PatternBar'
import PianoRoll from './components/PianoRoll'
import Playlist from './components/Playlist'
import SampleBrowser from './components/SampleBrowser'
import Toast from './components/Toast'
import WindowMenu from './components/WindowMenu'
import { selectNotes, useDawStore } from './state/useDawStore'
import { selectWindowOpen, useWindowStore } from './state/useWindowStore'

function App(): React.JSX.Element {
  const channels = useDawStore((state) => state.channels)
  const samples = useDawStore((state) => state.samples)
  const playingChannelIds = useDawStore((state) => state.playingChannelIds)
  const isImporting = useDawStore((state) => state.isImporting)
  const error = useDawStore((state) => state.error)
  const importSamples = useDawStore((state) => state.importSamples)
  const stopAll = useDawStore((state) => state.stopAll)
  const clearError = useDawStore((state) => state.clearError)
  const pianoRollChannelId = useDawStore((state) => state.pianoRollChannelId)
  const closePianoRoll = useDawStore((state) => state.closePianoRoll)
  const playMode = useDawStore((state) => state.playMode)
  const playback = useDawStore((state) => state.playback)
  const playSteps = useDawStore((state) => state.playSteps)
  const playSong = useDawStore((state) => state.playSong)
  const playPianoRoll = useDawStore((state) => state.playPianoRoll)
  const stopSequence = useDawStore((state) => state.stopSequence)
  const undo = useDawStore((state) => state.undo)
  const openProject = useDawStore((state) => state.openProject)
  const saveProject = useDawStore((state) => state.saveProject)
  /** How many notes the open roll has, which is what the ▶ button goes by too. */
  const pianoRollNoteCount = useDawStore((state) =>
    state.pianoRollChannelId === null ? 0 : selectNotes(state, state.pianoRollChannelId).length
  )

  // The library has no switch of its own any more: it is open exactly when its
  // window is, which is one fact in one place instead of two that can disagree.
  const libraryOpen = useWindowStore((state) => selectWindowOpen(state.windows, 'sample-browser'))
  const toggleWindow = useWindowStore((state) => state.toggleWindow)
  const setWorkArea = useWindowStore((state) => state.setWorkArea)

  // Resolved from the id rather than stored as an object, so the panel always
  // shows the channel's current notes and name.
  const pianoRollChannel = channels.find((channel) => channel.id === pianoRollChannelId)

  const stepsPlaying = playback?.mode === 'steps'

  const workspaceRef = useRef<HTMLDivElement>(null)

  /**
   * Tell the window store where the workspace is.
   *
   * Docked windows are kept inside this rectangle, and it is only knowable once
   * something has been laid out, so it is measured rather than configured: move
   * the toolbar or open the error banner and every docked window's limits move
   * with it.
   *
   * Measured in a layout effect, before the first paint, because the observer
   * alone is too late — its callback is asynchronous and can land after the
   * frame, which would show every window sitting at the defaults for one frame
   * and then jumping.
   */
  useLayoutEffect(() => {
    const element = workspaceRef.current
    if (element === null) return

    const measure = (): void => {
      const rect = element.getBoundingClientRect()
      setWorkArea({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })
    }

    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [setWorkArea])

  /**
   * The project's keyboard: the transport, undo, and the two file keys.
   *
   * Registered on the window because it belongs to whatever is on screen rather
   * than to any one panel: Space plays what is in front of you — the open piano
   * roll if there is one, the song in song mode, the step loop otherwise — which
   * is what makes it the same key in every view.
   */
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      // A field's own keys are its own: Space in a box is a space, not a transport.
      if (target?.closest('input, textarea') != null) return

      if (event.ctrlKey || event.metaKey) {
        // Undo, and the two file keys that are worth reaching for without the
        // menu. Nothing is bound to either by default, so there is no conflict.
        if (event.key.toLowerCase() === 'z') {
          event.preventDefault()
          undo()
          return
        }
        if (event.key.toLowerCase() === 's') {
          event.preventDefault()
          void saveProject()
          return
        }
        if (event.key.toLowerCase() === 'o') {
          event.preventDefault()
          void openProject()
          return
        }
      }

      // `code` rather than `key`: the space bar is one key whatever the layout
      // calls it, and this has to be the same key on every layout.
      if (event.code !== 'Space') return
      // Space would otherwise scroll the rack, or press whatever button was left
      // focused by the last click.
      event.preventDefault()

      if (playback !== null) {
        stopSequence()
        return
      }
      if (pianoRollChannelId !== null) {
        if (pianoRollNoteCount > 0) void playPianoRoll(pianoRollChannelId)
        return
      }
      if (playMode === 'song') {
        void playSong()
        return
      }
      void playSteps()
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [
    playback,
    playMode,
    pianoRollChannelId,
    pianoRollNoteCount,
    playSteps,
    playSong,
    playPianoRoll,
    stopSequence,
    undo,
    openProject,
    saveProject
  ])

  return (
    <div className="daw">
      <header className="toolbar">
        <span className="toolbar__title">my-daw · Channel Rack</span>
        <FileMenu />
        <WindowMenu />
        <BpmField />
        <button
          type="button"
          className="toolbar__button"
          aria-pressed={libraryOpen}
          onClick={() => toggleWindow('sample-browser')}
          title="打开内置采样库，点一个采样就直接建通道"
        >
          采样库
        </button>
        <button
          type="button"
          className="toolbar__button toolbar__button--primary"
          onClick={() => {
            void importSamples()
          }}
          disabled={isImporting}
        >
          {isImporting ? '导入中…' : '导入采样'}
        </button>
        <button
          type="button"
          className="toolbar__button toolbar__button--play"
          aria-pressed={stepsPlaying}
          onClick={() => {
            if (stepsPlaying) {
              stopSequence()
            } else {
              void playSteps()
            }
          }}
          title="按每行自己的步进数和 Swing 循环播放"
        >
          {stepsPlaying ? '⏸ 停止步进' : '▶ 播放步进'}
        </button>
        <button
          type="button"
          className="toolbar__button"
          onClick={stopAll}
          disabled={playingChannelIds.length === 0}
        >
          停止
        </button>
        <span className="toolbar__count">{channels.length} 个通道</span>
      </header>

      {error !== null && (
        <div className="banner" role="alert">
          <span className="banner__text">{error}</span>
          <button type="button" className="banner__close" onClick={clearError}>
            关闭
          </button>
        </div>
      )}

      <PatternBar />

      {/* The workspace: everything that is a window lives in here, and docked
          windows are kept inside it by the store. It has no visible box of its
          own — it is the region the windows are arranged in. */}
      <div className="daw-workspace" ref={workspaceRef}>
        {/* Rendered unconditionally, and each one subscribes only to its own
            record. App deliberately does not read `windows` itself: a drag
            replaces that array sixty times a second, and reading it here would
            re-render this component — and rebuild the elements below with it —
            on every frame of it. */}
        <DawWindow id="channel-rack">
          <main className="content">
            {channels.length === 0 ? (
              <p className="empty">
                还没有通道。从「采样库」里挑一个，或者点「导入采样」选音频文件，每个采样会成为机架上的一个通道。
              </p>
            ) : (
              <div className="rack">
                {channels.map((channel) => (
                  <ChannelRow
                    key={channel.id}
                    channel={channel}
                    sample={samples.find((item) => item.id === channel.sampleId)}
                    isPlaying={playingChannelIds.includes(channel.id)}
                    playback={playback}
                  />
                ))}
              </div>
            )}
          </main>
        </DawWindow>

        <DawWindow id="playlist">
          <Playlist />
        </DawWindow>

        <DawWindow id="sample-browser">
          <SampleBrowser />
        </DawWindow>

        {/* Closing this one has to stop its transport and drop the channel it
            was bound to, which is `closePianoRoll`'s job rather than the
            window's. The roll itself needs a channel: three other actions clear
            `pianoRollChannelId` without going through `closePianoRoll`, so the
            window can be open with nothing in it. */}
        <DawWindow
          id="piano-roll"
          title={
            pianoRollChannel === undefined ? '钢琴卷帘' : `钢琴卷帘 · ${pianoRollChannel.name}`
          }
          onRequestClose={closePianoRoll}
        >
          {pianoRollChannel === undefined ? (
            <p className="empty">在 Channel Rack 里双击一个通道，这里就会打开它的钢琴卷帘。</p>
          ) : (
            <PianoRoll
              channel={pianoRollChannel}
              sample={samples.find((item) => item.id === pianoRollChannel.sampleId)}
            />
          )}
        </DawWindow>
      </div>

      <Toast />
    </div>
  )
}

export default App
