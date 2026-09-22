import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import BpmField from './components/BpmField'
import ChannelRow from './components/ChannelRow'
import DawWindow from './components/DawWindow'
import EffectsPanel from './components/EffectsPanel'
import ExportDialog from './components/ExportDialog'
import FileMenu from './components/FileMenu'
import Knob from './components/Knob'
import PatternBar from './components/PatternBar'
import PianoRoll from './components/PianoRoll'
import Playlist from './components/Playlist'
import SampleBrowser from './components/SampleBrowser'
import StepsWindow from './components/StepsWindow'
import SynthPanel from './components/SynthPanel'
import Toast from './components/Toast'
import WindowMenu from './components/WindowMenu'
import { sampleOfChannel, selectNotes, useDawStore } from './state/useDawStore'
import type { SynthChannel } from './state/useDawStore'
import { selectWindowOpen, useWindowStore } from './state/useWindowStore'

/** The app's output level, written the way a channel's own volume is. */
function formatVolume(value: number): string {
  return `${Math.round(value * 100)}%`
}

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
  const synthPanelChannelId = useDawStore((state) => state.synthPanelChannelId)
  const closeSynthPanel = useDawStore((state) => state.closeSynthPanel)
  const effectsPanelChannelId = useDawStore((state) => state.effectsPanelChannelId)
  const closeEffectsPanel = useDawStore((state) => state.closeEffectsPanel)
  const addSynthChannel = useDawStore((state) => state.addSynthChannel)
  const playback = useDawStore((state) => state.playback)
  const playSteps = useDawStore((state) => state.playSteps)
  const playSong = useDawStore((state) => state.playSong)
  const playPianoRoll = useDawStore((state) => state.playPianoRoll)
  const stopSequence = useDawStore((state) => state.stopSequence)
  const masterVolume = useDawStore((state) => state.masterVolume)
  const setMasterVolume = useDawStore((state) => state.setMasterVolume)
  const undo = useDawStore((state) => state.undo)
  const openProject = useDawStore((state) => state.openProject)
  const saveProject = useDawStore((state) => state.saveProject)
  const loadUserSamples = useDawStore((state) => state.loadUserSamples)
  /** How many notes the open roll has, which is what the ▶ button goes by too. */
  const pianoRollNoteCount = useDawStore((state) =>
    state.pianoRollChannelId === null ? 0 : selectNotes(state, state.pianoRollChannelId).length
  )

  // The library has no switch of its own any more: it is open exactly when its
  // window is, which is one fact in one place instead of two that can disagree.
  const libraryOpen = useWindowStore((state) => selectWindowOpen(state.windows, 'sample-browser'))
  const toggleWindow = useWindowStore((state) => state.toggleWindow)
  const setWorkArea = useWindowStore((state) => state.setWorkArea)
  /**
   * Which window Space plays to: the one the mouse was last pressed inside.
   *
   * Read through the windows as well, because the two outlive each other — a
   * window can be closed with nothing there to clear this, and a window that is
   * gone has no transport to play. A boolean or an id, never an object, so this
   * only re-renders when the answer actually changes.
   */
  const focusedWindowId = useWindowStore((state) =>
    state.focusedId !== null && selectWindowOpen(state.windows, state.focusedId)
      ? state.focusedId
      : null
  )

  // Resolved from the id rather than stored as an object, so the panel always
  // shows the channel's current notes and name.
  const pianoRollChannel = channels.find((channel) => channel.id === pianoRollChannelId)
  // The same, and narrowed to a synth: the id can outlive a channel that was
  // deleted, and only a synth channel has parameters to show. The predicate is
  // written out because TypeScript only infers one from a single test, and this
  // has to be two to narrow at all.
  const synthPanelChannel = channels.find(
    (channel): channel is SynthChannel =>
      channel.id === synthPanelChannelId && channel.type === 'synth'
  )
  // Not narrowed: every channel has an effect chain, so any kind will do.
  const effectsPanelChannel = channels.find((channel) => channel.id === effectsPanelChannelId)

  const stepsPlaying = playback?.mode === 'steps'

  // Whether the export dialog is up. Local, because nothing outside it — not the
  // store, not the windows — cares that a mix is being written.
  const [exportOpen, setExportOpen] = useState(false)

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
   * Read the sample folder the app was last pointed at.
   *
   * Once, on startup, and only a directory listing: what comes back is a list of
   * names. Nothing is decoded until one of them is clicked, so opening the app
   * costs one readdir however large the folder is.
   *
   * A no-op the first time the app is ever run, when there is no folder to
   * remember — the store reports that as an empty sidebar rather than an error.
   */
  useEffect(() => {
    void loadUserSamples()
  }, [loadUserSamples])

  /**
   * The project's keyboard: the transport, undo, and the two file keys.
   *
   * Registered on the window because it belongs to whatever is on screen rather
   * than to any one panel. Space plays the window the mouse was last pressed in —
   * the roll in the piano roll, the arrangement in Song, the loop in the step
   * window — and does nothing in the two panels that have no transport of their
   * own. It is one key everywhere because it asks the window, not the app.
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

      // Stopping is the one thing that is not a window's: there is a single
      // transport, and Space ends it from wherever it is pressed.
      if (playback !== null) {
        stopSequence()
        return
      }

      switch (focusedWindowId) {
        case 'piano-roll':
          // An open roll need not be bound to anything, and an empty one has
          // nothing to play — no transport, so no reaction.
          if (pianoRollChannelId !== null && pianoRollNoteCount > 0) {
            void playPianoRoll(pianoRollChannelId)
          }
          return
        case 'playlist':
          void playSong()
          return
        case 'steps':
          void playSteps()
          return
        // The ones without a transport of their own. Space in either parameter
        // panel would only stop whatever the user is listening to while they
        // turn a knob, which is the opposite of what either is open for.
        case 'channel-rack':
        case 'sample-browser':
        case 'synth-panel':
        case 'effects-panel':
          return
        case null:
          // Nothing has been pointed at yet, so there is no window to ask. The
          // arrangement is the answer, being the one thing that is always there.
          void playSong()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [
    playback,
    focusedWindowId,
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
        {/* The app's own level, next to the transport it applies to. It is not a
            channel's and not the song's: nothing here is written down, so a
            project saved with the knob down reopens at 100%. */}
        <Knob
          label="总音量"
          value={masterVolume}
          min={0}
          max={1}
          defaultValue={1}
          format={formatVolume}
          onChange={setMasterVolume}
        />
        <button
          type="button"
          className="toolbar__button"
          onClick={stopAll}
          disabled={playingChannelIds.length === 0}
        >
          停止
        </button>
        <button
          type="button"
          className="toolbar__button"
          onClick={() => setExportOpen(true)}
          title="把整首 Song 离线渲染成一个音频文件"
        >
          导出音频
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
            {/* The rack's own toolbar. It has one button because there is one
                thing you add here without going to the library: a channel that
                needs no sample, since it makes its own sound. */}
            <div className="rack-bar">
              <button
                type="button"
                className="rack-bar__button"
                onClick={addSynthChannel}
                title="新建一个合成器通道（不加载采样，用振荡器发声）"
              >
                + 合成器
              </button>
              <span className="rack-bar__count">
                {channels.length === 0 ? '还没有通道' : `${channels.length} 个通道`}
              </span>
            </div>

            {channels.length === 0 ? (
              <p className="empty">
                还没有通道。从「采样库」里挑一个，或者点「导入采样」选音频文件，每个采样会成为机架上的一个通道；也可以点上面的「+
                合成器」直接建一个用振荡器发声的通道。
              </p>
            ) : (
              <div className="rack">
                {channels.map((channel) => (
                  <ChannelRow
                    key={channel.id}
                    channel={channel}
                    sample={sampleOfChannel(samples, channel)}
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

        <DawWindow id="steps">
          <StepsWindow />
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
              sample={sampleOfChannel(samples, pianoRollChannel)}
            />
          )}
        </DawWindow>

        {/* The parameter panel. Like the roll it can be open with nothing in it
            — a synth channel can be deleted, and the window id is written down
            while the channel it pointed at is not — so it says what to do about
            that instead of drawing an empty panel.

            It deliberately has no `onRequestClose`: closing it stops nothing, so
            the window's own close button and `closeSynthPanel` are the same act. */}
        <DawWindow
          id="synth-panel"
          title={synthPanelChannel === undefined ? '合成器' : `合成器 · ${synthPanelChannel.name}`}
          onRequestClose={closeSynthPanel}
        >
          {synthPanelChannel === undefined ? (
            <p className="empty">
              在 Channel Rack 里双击一个合成器通道，这里就会打开它的参数；还没有的话，点「+
              合成器」新建一个。
            </p>
          ) : (
            <SynthPanel channel={synthPanelChannel} />
          )}
        </DawWindow>

        {/* The effect chain. Open with nothing in it for the same reason the
            parameter panel is — the id outlives the channel it pointed at — and
            like that one it has no `onRequestClose`, because closing it stops
            nothing: the chain it was showing is the channel's, not the window's,
            and it keeps playing exactly as it was. */}
        <DawWindow
          id="effects-panel"
          title={
            effectsPanelChannel === undefined ? '效果器' : `效果器 · ${effectsPanelChannel.name}`
          }
          onRequestClose={closeEffectsPanel}
        >
          {effectsPanelChannel === undefined ? (
            <p className="empty">
              在 Channel Rack 里点一个通道的 FX
              按钮，这里就会打开它的效果链；还没有通道的话，先导入一个采样或新建一个合成器。
            </p>
          ) : (
            <EffectsPanel channel={effectsPanelChannel} />
          )}
        </DawWindow>
      </div>

      {exportOpen && <ExportDialog onClose={() => setExportOpen(false)} />}

      <Toast />
    </div>
  )
}

export default App
