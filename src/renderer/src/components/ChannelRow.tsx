import { useState } from 'react'
import ChannelSteps from './ChannelSteps'
import ContextMenu, { type ContextMenuItem } from './ContextMenu'
import Knob from './Knob'
import SamplePicker from './SamplePicker'
import StepCountSwitch from './StepCountSwitch'
import WaveformThumbnail from './WaveformThumbnail'
import { useStepCursor } from '../hooks/useStepCursor'
import {
  DEFAULT_PAN,
  DEFAULT_VOLUME,
  selectChannelPlayback,
  selectNotes,
  selectSteps,
  useDawStore
} from '../state/useDawStore'
import type { Channel, Playback, Sample } from '../state/useDawStore'
import type { StepCount } from '../types/step'

type ChannelRowProps = {
  channel: Channel
  sample: Sample | undefined
  isPlaying: boolean
  /** The transport, so this row can follow the step loop's own position. */
  playback: Playback | null
}

/** Seconds -> m:ss.mmm, e.g. 63.25 -> "1:03.250". */
function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  const rest = seconds - minutes * 60
  return `${minutes}:${rest.toFixed(3).padStart(6, '0')}`
}

function formatVolume(value: number): string {
  return `${Math.round(value * 100)}%`
}

function formatPan(value: number): string {
  if (value < -0.005) return `L${Math.round(-value * 100)}`
  if (value > 0.005) return `R${Math.round(value * 100)}`
  return 'C'
}

function formatSwing(value: number): string {
  return `${Math.round(value)}%`
}

/**
 * One channel of the rack.
 *
 * The waveform is the play target and the name is the rename target on purpose:
 * if the name also played the sample, the first click of every double-click
 * would fire a note.
 */
function ChannelRow({ channel, sample, isPlaying, playback }: ChannelRowProps): React.JSX.Element {
  const triggerChannel = useDawStore((state) => state.triggerChannel)
  const renameChannel = useDawStore((state) => state.renameChannel)
  const setVolume = useDawStore((state) => state.setVolume)
  const setPan = useDawStore((state) => state.setPan)
  const setSwing = useDawStore((state) => state.setSwing)
  const setStepCount = useDawStore((state) => state.setStepCount)
  const toggleMute = useDawStore((state) => state.toggleMute)
  const toggleSolo = useDawStore((state) => state.toggleSolo)
  const duplicateChannel = useDawStore((state) => state.duplicateChannel)
  const removeChannel = useDawStore((state) => state.removeChannel)
  const openPianoRoll = useDawStore((state) => state.openPianoRoll)
  const playChannelSequence = useDawStore((state) => state.playChannelSequence)
  const stopSequence = useDawStore((state) => state.stopSequence)
  const channelPlayback = useDawStore((state) => selectChannelPlayback(state, channel.id))

  /** Non-null while the name is being edited. */
  const [draft, setDraft] = useState<string | null>(null)
  /**
   * Whether this row's step grid is showing. Per row and purely visual, so it
   * lives here rather than in the store — the steps themselves do not.
   */
  const [stepsOpen, setStepsOpen] = useState(true)
  /** Where the row's right-click menu is open, or null. */
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  /** Whether this row's sound picker is open. */
  const [picking, setPicking] = useState(false)

  // Each row reads its own position: channels loop over their own step counts,
  // so there is no single "current step" the rack could be handed from above.
  const currentStep = useStepCursor(playback, channel.id)

  const commitRename = (): void => {
    if (draft === null) return
    const name = draft.trim()
    if (name !== '' && name !== channel.name) {
      renameChannel(channel.id, name)
    }
    setDraft(null)
  }

  const sequencePlaying = channelPlayback !== null
  // The row shows the current pattern's notes and steps, so switching pattern
  // changes what the whole rack shows.
  const notes = useDawStore((state) => selectNotes(state, channel.id))
  const steps = useDawStore((state) => selectSteps(state, channel.id))
  const activeSteps = steps.slice(0, channel.stepCount).filter(Boolean).length

  /**
   * Whether this channel is making a sound right now.
   *
   * A step loop cannot use the strip's own activity for this: its voices are
   * reserved up to a lookahead ahead of the clock, so the strip reads as busy
   * before it is audible — and, since one step's voice lasts until the next lit
   * one, it would read as busy through the rests as well. The cursor knows which
   * step the clock is inside, so the LED follows that instead.
   */
  const isSounding =
    playback?.mode === 'steps' ? currentStep !== null && steps[currentStep] === true : isPlaying

  /**
   * The waveform is the channel's play button: a channel that has notes plays its
   * sequence, and an empty one auditions the sample so it still makes a sound.
   */
  const handlePlayClick = (): void => {
    if (notes.length === 0) {
      void triggerChannel(channel.id)
      return
    }
    if (sequencePlaying) {
      stopSequence()
    } else {
      void playChannelSequence(channel.id)
    }
  }

  /**
   * Double-clicking the channel opens its Piano Roll.
   *
   * The controls keep their double-clicks — the name renames, the knobs reset —
   * and the buttons are single-click actions, so anything that is already one of
   * those is left alone.
   */
  const handleDoubleClick = (event: React.MouseEvent<HTMLDivElement>): void => {
    if ((event.target as HTMLElement).closest('.channel__name, .knob, button') !== null) return
    openPianoRoll(channel.id)
  }

  /**
   * The row's own menu.
   *
   * Two of these reach past the row, for the same reason: a channel is one thing
   * however many patterns use it. Delete takes its notes and steps with it — they
   * are filed under its id in every pattern — and 更换音色 changes what every
   * pattern's use of it sounds like. Delete is one undo step, which is what it
   * relies on instead of asking first; a sound change is one too.
   */
  const menuItems: ContextMenuItem[] = [
    { label: '重命名', run: () => setDraft(channel.name) },
    { label: '复制', run: () => duplicateChannel(channel.id) },
    { label: '更换音色…', run: () => setPicking(true) },
    { label: '删除', danger: true, run: () => removeChannel(channel.id) }
  ]

  return (
    <>
      <div
        className="channel"
        onDoubleClick={handleDoubleClick}
        onContextMenu={(event) => {
          event.preventDefault()
          setMenu({ x: event.clientX, y: event.clientY })
        }}
      >
        <span className="channel__led" data-active={isSounding} aria-hidden="true" />

        <div className="channel__identity" title="双击通道其他位置打开钢琴卷帘">
          {draft === null ? (
            <span
              className="channel__name"
              title="双击重命名"
              onDoubleClick={() => setDraft(channel.name)}
            >
              {channel.name}
            </span>
          ) : (
            <input
              className="channel__name-input"
              value={draft}
              autoFocus
              onChange={(event) => setDraft(event.target.value)}
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
          )}
          <span className="channel__meta">
            {sample ? formatDuration(sample.durationSec) : '采样缺失'}
            {notes.length > 0 ? ` · ${notes.length} 音符` : ''}
            {activeSteps > 0 ? ` · ${activeSteps} 步进` : ''}
          </span>
        </div>

        {/* Sits against the waveform rather than at the row's end, so what it opens
          is next to what it points at. */}
        <button
          type="button"
          className="channel__steps-toggle"
          aria-expanded={stepsOpen}
          onClick={() => setStepsOpen((open) => !open)}
          title={stepsOpen ? '收起步进网格' : '展开步进网格'}
          aria-label={stepsOpen ? '收起步进网格' : '展开步进网格'}
        >
          {stepsOpen ? '▾' : '▸'}
        </button>

        <button
          type="button"
          className="channel__wave"
          onClick={handlePlayClick}
          title={
            sample === undefined
              ? '采样缺失'
              : notes.length > 0
                ? sequencePlaying
                  ? '停止播放音符序列'
                  : `播放 ${notes.length} 个音符的序列`
                : `试听 ${sample.name}`
          }
        >
          {sample ? (
            <WaveformThumbnail peaks={sample.peaks} isPlaying={isSounding} />
          ) : (
            <span className="channel__missing">—</span>
          )}
        </button>

        <Knob
          label="音量"
          value={channel.volume}
          min={0}
          max={1}
          defaultValue={DEFAULT_VOLUME}
          format={formatVolume}
          onChange={(value) => setVolume(channel.id, value)}
        />
        <Knob
          label="声像"
          value={channel.pan}
          min={-1}
          max={1}
          defaultValue={DEFAULT_PAN}
          format={formatPan}
          bipolar
          onChange={(value) => setPan(channel.id, value)}
        />

        <button
          type="button"
          className="channel__toggle channel__toggle--mute"
          aria-pressed={channel.muted}
          onClick={() => toggleMute(channel.id)}
          title="静音"
        >
          M
        </button>
        <button
          type="button"
          className="channel__toggle channel__toggle--solo"
          aria-pressed={channel.soloed}
          onClick={() => toggleSolo(channel.id)}
          title="独奏"
        >
          S
        </button>

        <button
          type="button"
          className="channel__clone"
          onClick={() => duplicateChannel(channel.id)}
          title="复制通道"
          aria-label="复制通道"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <rect x="0.5" y="0.5" width="7" height="7" rx="1" fill="none" stroke="currentColor" />
            <rect x="4.5" y="4.5" width="7" height="7" rx="1" fill="none" stroke="currentColor" />
          </svg>
        </button>

        {stepsOpen && (
          <>
            <Knob
              label="Swing"
              value={channel.swing}
              min={0}
              max={100}
              defaultValue={0}
              format={formatSwing}
              onChange={(value) => setSwing(channel.id, value)}
            />
            <ChannelSteps
              channelId={channel.id}
              steps={steps}
              stepCount={channel.stepCount}
              color={channel.color}
              currentStep={currentStep}
            />
          </>
        )}

        <StepCountSwitch
          value={channel.stepCount}
          onChange={(stepCount: StepCount) => setStepCount(channel.id, stepCount)}
        />
      </div>

      {/* Outside the row, so a right-click inside the menu does not bubble back
          to the row and reopen it. */}
      {menu !== null && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      )}

      {picking && (
        <SamplePicker
          channels={[channel]}
          context={`换掉「${channel.name}」的采样。音色是通道的属性，所以这个通道在所有 Pattern 里的音色都会跟着变；音符、步进、音量和声像都不动。`}
          onClose={() => setPicking(false)}
        />
      )}
    </>
  )
}

export default ChannelRow
