import { useState } from 'react'
import ContextMenu, { type ContextMenuItem } from './ContextMenu'
import Knob from './Knob'
import SamplePicker from './SamplePicker'
import SynthThumbnail from './SynthThumbnail'
import WaveformThumbnail from './WaveformThumbnail'
import { useChannelLevel } from '../hooks/useChannelLevel'
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
import { EFFECT_TYPE_LABELS } from '../types/effect'
import { WAVEFORM_LABELS } from '../types/synth'

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

/** What a channel has under its name, in the row: what it plays or what it is. */
function channelDescription(channel: Channel, sample: Sample | undefined): string {
  if (channel.type !== 'synth') {
    // A sampler whose file went missing says so rather than showing a duration
    // it does not have.
    return sample === undefined ? '采样缺失' : formatDuration(sample.durationSec)
  }
  const count = channel.synth.oscCount === 2 ? '2 振荡器' : '1 振荡器'
  return `${WAVEFORM_LABELS[channel.synth.waveform]} · ${count}`
}

/**
 * What the FX button says on hover.
 *
 * It spells the chain out rather than just counting it: the question the button
 * raises is what this channel has between it and the fader, and "2" does not
 * answer that. Bypassed effects are listed and marked as bypassed rather than
 * left out — they are still on the chain, and a tooltip that disagreed with the
 * dimmed card on the panel would be the wrong one of the two.
 *
 * The order is the chain's own, which is the point: it is read as a signal path.
 */
function effectsTitle(channel: Channel): string {
  if (channel.effects.length === 0) return '打开效果链，加混响、延迟或失真'
  const parts = channel.effects.map((effect) => {
    const label = EFFECT_TYPE_LABELS[effect.type]
    return effect.enabled ? label : `${label}（已关）`
  })
  return `效果链：${parts.join(' → ')}`
}

/**
 * One channel of the rack.
 *
 * The waveform is the play target and the name is the rename target on purpose:
 * if the name also played the sample, the first click of every double-click
 * would fire a note. The same goes for what the waveform *is* — a peak envelope
 * on a sampler and a drawn cycle on a synth — since both are just the picture on
 * the button.
 *
 * The step grid is not here. It is the 步进 window's, and what this row keeps of
 * it is the count in the metadata line — enough to see at a glance whether a
 * channel has anything switched on, without the rack being as wide as the
 * longest grid in it.
 */
function ChannelRow({ channel, sample, isPlaying, playback }: ChannelRowProps): React.JSX.Element {
  const triggerChannel = useDawStore((state) => state.triggerChannel)
  const renameChannel = useDawStore((state) => state.renameChannel)
  const setVolume = useDawStore((state) => state.setVolume)
  const setPan = useDawStore((state) => state.setPan)
  const toggleMute = useDawStore((state) => state.toggleMute)
  const toggleSolo = useDawStore((state) => state.toggleSolo)
  const duplicateChannel = useDawStore((state) => state.duplicateChannel)
  const removeChannel = useDawStore((state) => state.removeChannel)
  const openPianoRoll = useDawStore((state) => state.openPianoRoll)
  const openSynthPanel = useDawStore((state) => state.openSynthPanel)
  const openEffectsPanel = useDawStore((state) => state.openEffectsPanel)
  const effectsOpen = useDawStore((state) => state.effectsPanelChannelId === channel.id)
  const playChannelSequence = useDawStore((state) => state.playChannelSequence)
  const stopSequence = useDawStore((state) => state.stopSequence)
  const channelPlayback = useDawStore((state) => selectChannelPlayback(state, channel.id))

  /** Non-null while the name is being edited. */
  const [draft, setDraft] = useState<string | null>(null)
  /** Where the row's right-click menu is open, or null. */
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  /** Whether this row's sound picker is open. */
  const [picking, setPicking] = useState(false)

  // The grid is drawn in the 步进 window now, but the indicator is not a grid: a
  // row still lights while its own loop is on a step that fires, and each row has
  // to work that out for itself.
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

  // The meter reads the strip rather than `isSounding`, and that is the
  // difference between the two: a step loop's cursor says when a step was
  // *asked* to fire, which is not the same as it being audible right now. The
  // strip's own output is the thing being measured, so this is `isPlaying` — the
  // flag the LED would use if the LED could wait for the sound.
  const meterRef = useChannelLevel(channel.id, isPlaying)

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
   * What pressing the button will do.
   *
   * A synth's audition is one note rather than a recording, so it says 试听 too
   * and leaves the "what" to the metadata line above — which is where the
   * waveform and the oscillator count already are.
   */
  const waveTitle = ((): string => {
    if (channel.type !== 'synth' && sample === undefined) return '采样缺失'
    if (notes.length > 0) {
      return sequencePlaying ? '停止播放音符序列' : `播放 ${notes.length} 个音符的序列`
    }
    return sample === undefined ? `试听「${channel.name}」` : `试听 ${sample.name}`
  })()

  /**
   * Double-clicking the channel opens the panel that channel has.
   *
   * Which one is the whole of the difference between the two kinds here: a synth
   * has no recording, so the thing worth opening on it is the sound it makes
   * instead — and its roll is still reachable, from the menu below.
   *
   * The controls keep their double-clicks — the name renames, the knobs reset —
   * and the buttons are single-click actions, so anything that is already one of
   * those is left alone.
   */
  const handleDoubleClick = (event: React.MouseEvent<HTMLDivElement>): void => {
    if ((event.target as HTMLElement).closest('.channel__name, .knob, button') !== null) return
    if (channel.type === 'synth') {
      openSynthPanel(channel.id)
    } else {
      openPianoRoll(channel.id)
    }
  }

  /**
   * The row's own menu.
   *
   * Two of these reach past the row, for the same reason: a channel is one thing
   * however many patterns use it. Delete takes its notes and steps with it — they
   * are filed under its id in every pattern — and 更换音色 changes what every
   * pattern's use of it sounds like. Delete is one undo step, which is what it
   * relies on instead of asking first; a sound change is one too.
   *
   * A synth row's menu says so instead: 更换音色 is a sampler's idea — there is no
   * recording to swap — so it is replaced by the panels that channel can open.
   * Double-click reaches the parameter panel already, and the roll does not have a
   * double-click left over for it, which is why the roll is listed here.
   *
   * 效果器 is the one entry both menus carry, and it is the same act on either
   * kind: a reverb is not an instrument, so there is nothing about it that has to
   * be said twice.
   */
  const menuItems: ContextMenuItem[] =
    channel.type === 'synth'
      ? [
          { label: '重命名', run: () => setDraft(channel.name) },
          { label: '复制', run: () => duplicateChannel(channel.id) },
          { label: '合成器参数', run: () => openSynthPanel(channel.id) },
          { label: '效果器', run: () => openEffectsPanel(channel.id) },
          { label: '打开钢琴卷帘', run: () => openPianoRoll(channel.id) },
          { label: '删除', danger: true, run: () => removeChannel(channel.id) }
        ]
      : [
          { label: '重命名', run: () => setDraft(channel.name) },
          { label: '复制', run: () => duplicateChannel(channel.id) },
          { label: '更换音色…', run: () => setPicking(true) },
          { label: '效果器', run: () => openEffectsPanel(channel.id) },
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
            {channelDescription(channel, sample)}
            {notes.length > 0 ? ` · ${notes.length} 音符` : ''}
            {activeSteps > 0 ? ` · ${activeSteps} 步进` : ''}
          </span>
          <span className="channel__meter" ref={meterRef} aria-hidden="true" />
        </div>

        <button type="button" className="channel__wave" onClick={handlePlayClick} title={waveTitle}>
          {channel.type === 'synth' ? (
            <SynthThumbnail
              waveform={channel.synth.waveform}
              oscCount={channel.synth.oscCount}
              isPlaying={isSounding}
            />
          ) : sample ? (
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

        {/* The one door into the effect chain. The count is on the button rather
            than in the metadata line above, because a chain is a thing you go and
            look at: what matters from here is whether there is one to look at. */}
        <button
          type="button"
          className="channel__fx"
          aria-pressed={effectsOpen}
          onClick={() => openEffectsPanel(channel.id)}
          title={effectsTitle(channel)}
          aria-label="效果器"
        >
          FX
          {channel.effects.length > 0 && (
            <span className="channel__fx-count">{channel.effects.length}</span>
          )}
        </button>
      </div>

      {/* Outside the row, so a right-click inside the menu does not bubble back
          to the row and reopen it. */}
      {menu !== null && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      )}

      {/* `picking` is only ever set from a sampler's menu, so the second test is
          for the type checker's benefit — and it lets `[channel]` be a list of
          samplers, which is what the dialog can be pointed at. */}
      {picking && channel.type !== 'synth' && (
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
