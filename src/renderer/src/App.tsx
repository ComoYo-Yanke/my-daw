import { useEffect } from 'react'
import BpmField from './components/BpmField'
import ChannelRow from './components/ChannelRow'
import FileMenu from './components/FileMenu'
import PatternBar from './components/PatternBar'
import PianoRoll from './components/PianoRoll'
import Playlist from './components/Playlist'
import SampleBrowser from './components/SampleBrowser'
import Toast from './components/Toast'
import { selectNotes, useDawStore } from './state/useDawStore'

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
  const playMode = useDawStore((state) => state.playMode)
  const playback = useDawStore((state) => state.playback)
  const playSteps = useDawStore((state) => state.playSteps)
  const playSong = useDawStore((state) => state.playSong)
  const playPianoRoll = useDawStore((state) => state.playPianoRoll)
  const stopSequence = useDawStore((state) => state.stopSequence)
  const undo = useDawStore((state) => state.undo)
  const libraryOpen = useDawStore((state) => state.libraryOpen)
  const toggleLibrary = useDawStore((state) => state.toggleLibrary)
  const openProject = useDawStore((state) => state.openProject)
  const saveProject = useDawStore((state) => state.saveProject)
  /** How many notes the open roll has, which is what the ▶ button goes by too. */
  const pianoRollNoteCount = useDawStore((state) =>
    state.pianoRollChannelId === null ? 0 : selectNotes(state, state.pianoRollChannelId).length
  )

  // Resolved from the id rather than stored as an object, so the panel always
  // shows the channel's current notes and name.
  const pianoRollChannel = channels.find((channel) => channel.id === pianoRollChannelId)

  const stepsPlaying = playback?.mode === 'steps'

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
        <BpmField />
        <button
          type="button"
          className="toolbar__button"
          aria-pressed={libraryOpen}
          onClick={toggleLibrary}
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

      {/* The library sits beside the rack rather than over it, and the piano
          roll stays below both: what the sidebar takes is width, and the rack is
          the thing that has width to spare. */}
      <div className="daw__body">
        {libraryOpen && <SampleBrowser />}

        <div className="daw__main">
          <PatternBar />

          {playMode === 'song' && <Playlist />}

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
        </div>
      </div>

      {pianoRollChannel !== undefined && (
        <PianoRoll
          channel={pianoRollChannel}
          sample={samples.find((item) => item.id === pianoRollChannel.sampleId)}
        />
      )}

      <Toast />
    </div>
  )
}

export default App
