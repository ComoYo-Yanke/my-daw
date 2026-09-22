import Knob from './Knob'
import { useDawStore } from '../state/useDawStore'
import type { Channel } from '../state/useDawStore'
import {
  DEFAULT_DELAY_PARAMS,
  DEFAULT_DISTORTION_PARAMS,
  DEFAULT_REVERB_PARAMS,
  EFFECT_TYPES,
  EFFECT_TYPE_HINTS,
  EFFECT_TYPE_LABELS,
  MAX_DAMPING,
  MAX_DELAY_SEC,
  MAX_DRIVE,
  MAX_FEEDBACK,
  MAX_OUTPUT_GAIN,
  MAX_ROOM_SIZE,
  MAX_TONE_HZ,
  MAX_WET,
  MIN_DAMPING,
  MIN_DELAY_SEC,
  MIN_DRIVE,
  MIN_FEEDBACK,
  MIN_OUTPUT_GAIN,
  MIN_ROOM_SIZE,
  MIN_TONE_HZ,
  MIN_WET,
  type DelayParams,
  type DistortionParams,
  type Effect,
  type ReverbParams
} from '../types/effect'

type EffectsPanelProps = {
  channel: Channel
}

type ReverbEffect = Extract<Effect, { type: 'reverb' }>
type DelayEffect = Extract<Effect, { type: 'delay' }>
type DistortionEffect = Extract<Effect, { type: 'distortion' }>

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`
}

function formatSeconds(value: number): string {
  return `${value.toFixed(2)} s`
}

function formatHz(value: number): string {
  if (value >= 1000) return `${(value / 1000).toFixed(2)} kHz`
  return `${Math.round(value)} Hz`
}

/**
 * One effect's knobs.
 *
 * Three separate bodies rather than one that switches on the field name, which
 * is the same decision the `Effect` union makes one level down: a reverb has no
 * drive, so there is nothing here for a shared body to lay out for it. Each of
 * the three narrows to its own parameters at the point the card hands it over,
 * so every knob below is written against a concrete type and none of them can
 * name a field that belongs to a different effect.
 *
 * Each body's `set` merges a one-field patch into the effect's own parameters
 * and hands the whole set back, which is what `updateEffect` takes. `key` names
 * the gesture, so one turn of one knob is one undo step.
 */

type ReverbBodyProps = { channelId: string; effect: ReverbEffect }

function ReverbBody({ channelId, effect }: ReverbBodyProps): React.JSX.Element {
  const updateEffect = useDawStore((state) => state.updateEffect)
  const params = effect.params
  const set = (patch: Partial<ReverbParams>, key?: string): void =>
    updateEffect(channelId, effect.id, { ...params, ...patch }, key)

  return (
    <div className="effect__knobs">
      <Knob
        label="房间大小"
        value={params.roomSize}
        min={MIN_ROOM_SIZE}
        max={MAX_ROOM_SIZE}
        defaultValue={DEFAULT_REVERB_PARAMS.roomSize}
        format={formatPercent}
        onChange={(value) => set({ roomSize: value }, 'roomSize')}
      />
      <Knob
        label="阻尼"
        value={params.damping}
        min={MIN_DAMPING}
        max={MAX_DAMPING}
        defaultValue={DEFAULT_REVERB_PARAMS.damping}
        format={formatPercent}
        onChange={(value) => set({ damping: value }, 'damping')}
      />
      <Knob
        label="湿声"
        value={params.wet}
        min={MIN_WET}
        max={MAX_WET}
        defaultValue={DEFAULT_REVERB_PARAMS.wet}
        format={formatPercent}
        onChange={(value) => set({ wet: value }, 'wet')}
      />
    </div>
  )
}

type DelayBodyProps = { channelId: string; effect: DelayEffect }

function DelayBody({ channelId, effect }: DelayBodyProps): React.JSX.Element {
  const updateEffect = useDawStore((state) => state.updateEffect)
  const params = effect.params
  const set = (patch: Partial<DelayParams>, key?: string): void =>
    updateEffect(channelId, effect.id, { ...params, ...patch }, key)

  return (
    <div className="effect__knobs">
      <Knob
        label="延迟时间"
        value={params.timeSec}
        min={MIN_DELAY_SEC}
        max={MAX_DELAY_SEC}
        defaultValue={DEFAULT_DELAY_PARAMS.timeSec}
        format={formatSeconds}
        onChange={(value) => set({ timeSec: value }, 'timeSec')}
      />
      <Knob
        label="反馈"
        value={params.feedback}
        min={MIN_FEEDBACK}
        max={MAX_FEEDBACK}
        defaultValue={DEFAULT_DELAY_PARAMS.feedback}
        format={formatPercent}
        onChange={(value) => set({ feedback: value }, 'feedback')}
      />
      <Knob
        label="湿声"
        value={params.wet}
        min={MIN_WET}
        max={MAX_WET}
        defaultValue={DEFAULT_DELAY_PARAMS.wet}
        format={formatPercent}
        onChange={(value) => set({ wet: value }, 'wet')}
      />
    </div>
  )
}

type DistortionBodyProps = { channelId: string; effect: DistortionEffect }

function DistortionBody({ channelId, effect }: DistortionBodyProps): React.JSX.Element {
  const updateEffect = useDawStore((state) => state.updateEffect)
  const params = effect.params
  const set = (patch: Partial<DistortionParams>, key?: string): void =>
    updateEffect(channelId, effect.id, { ...params, ...patch }, key)

  return (
    <div className="effect__knobs">
      <Knob
        label="驱动"
        value={params.drive}
        min={MIN_DRIVE}
        max={MAX_DRIVE}
        defaultValue={DEFAULT_DISTORTION_PARAMS.drive}
        format={formatPercent}
        onChange={(value) => set({ drive: value }, 'drive')}
      />
      {/* Log, like the synth's cutoff and for the same reason: pitch is
          logarithmic, so an octave should be the same distance wherever it is
          rather than the top half of the range being four notes. */}
      <Knob
        label="音调"
        value={Math.log(params.toneHz)}
        min={Math.log(MIN_TONE_HZ)}
        max={Math.log(MAX_TONE_HZ)}
        defaultValue={Math.log(DEFAULT_DISTORTION_PARAMS.toneHz)}
        format={(value) => formatHz(Math.exp(value))}
        onChange={(value) => set({ toneHz: Math.exp(value) }, 'toneHz')}
      />
      <Knob
        label="输出"
        value={params.outputGain}
        min={MIN_OUTPUT_GAIN}
        max={MAX_OUTPUT_GAIN}
        defaultValue={DEFAULT_DISTORTION_PARAMS.outputGain}
        format={formatPercent}
        onChange={(value) => set({ outputGain: value }, 'outputGain')}
      />
    </div>
  )
}

/**
 * One card in the chain: its place, whether it is on, and its knobs.
 *
 * The buttons say what they do rather than describing state: `⏻` is the bypass
 * switch and reads as pressed while the effect is on, `↑`/`↓` move this effect
 * through the chain, `✕` takes it off. Moving past either end is not an error
 * and does nothing, which is why the arrows stay live at the ends — a control
 * that greys out invites the question of what would have to change for it to
 * work, and the answer is nothing that could.
 *
 * A bypassed effect keeps its card, its place and every number on it, dimmed
 * rather than gone: the switch is for hearing the channel without it, and a
 * switch that threw away the settings would be a delete button wearing a
 * different label.
 */
function EffectCard({
  channelId,
  effect,
  index,
  count
}: {
  channelId: string
  effect: Effect
  index: number
  count: number
}): React.JSX.Element {
  const toggleEffect = useDawStore((state) => state.toggleEffect)
  const removeEffect = useDawStore((state) => state.removeEffect)
  const moveEffect = useDawStore((state) => state.moveEffect)

  const label = EFFECT_TYPE_LABELS[effect.type]

  return (
    <article className="effect" data-enabled={effect.enabled}>
      <header className="effect__bar">
        <button
          type="button"
          className="effect__power"
          aria-pressed={effect.enabled}
          title={effect.enabled ? '关掉它（参数留着）' : '打开它'}
          aria-label={effect.enabled ? `关闭${label}` : `打开${label}`}
          onClick={() => toggleEffect(channelId, effect.id)}
        >
          ⏻
        </button>
        <span className="effect__index" aria-hidden="true">
          {index + 1}
        </span>
        <span className="effect__name">{label}</span>

        <button
          type="button"
          className="effect__move"
          disabled={index === 0}
          title="往上挪一格，先经过它"
          aria-label={`把${label}往上挪`}
          onClick={() => moveEffect(channelId, effect.id, -1)}
        >
          ↑
        </button>
        <button
          type="button"
          className="effect__move"
          disabled={index === count - 1}
          title="往下挪一格，后经过它"
          aria-label={`把${label}往下挪`}
          onClick={() => moveEffect(channelId, effect.id, 1)}
        >
          ↓
        </button>
        <button
          type="button"
          className="effect__remove"
          title="从链上删掉"
          aria-label={`删掉${label}`}
          onClick={() => removeEffect(channelId, effect.id)}
        >
          ✕
        </button>
      </header>

      <div className="effect__body">
        {effect.type === 'reverb' && <ReverbBody channelId={channelId} effect={effect} />}
        {effect.type === 'delay' && <DelayBody channelId={channelId} effect={effect} />}
        {effect.type === 'distortion' && <DistortionBody channelId={channelId} effect={effect} />}
      </div>
    </article>
  )
}

/**
 * One channel's effect chain, in order.
 *
 * The list is drawn top to bottom in the order the sound goes through it, which
 * is the one thing about a chain a picture can say that a row of knobs cannot:
 * what the reverb is reverb-ing. Adding puts the new one at the bottom because
 * that is where the sound has got to by then.
 *
 * Deliberately no play button, for the reason the synth panel has none either:
 * the transport belongs to the window the mouse is in, and the point of this one
 * is to turn a knob while the part it belongs to is playing. A second transport
 * here would be a way to stop hearing the thing being tuned.
 */
function EffectsPanel({ channel }: EffectsPanelProps): React.JSX.Element {
  const addEffect = useDawStore((state) => state.addEffect)
  const effects = channel.effects

  return (
    <section className="effects" aria-label="效果链">
      <header className="effects__header">
        <span className="effects__label">添加</span>
        {EFFECT_TYPES.map((type) => (
          <button
            key={type}
            type="button"
            className="effects__add"
            title={EFFECT_TYPE_HINTS[type]}
            onClick={() => addEffect(channel.id, type)}
          >
            ＋ {EFFECT_TYPE_LABELS[type]}
          </button>
        ))}
        <span className="effects__hint">声音从上往下依次经过，播放时拧旋钮就能听到</span>
      </header>

      {effects.length === 0 ? (
        <p className="effects__empty">
          这个通道还没有效果器。加一个，它会接在链尾 —— 加完就能边放边拧。
        </p>
      ) : (
        <div className="effects__list">
          {effects.map((effect, index) => (
            <EffectCard
              key={effect.id}
              channelId={channel.id}
              effect={effect}
              index={index}
              count={effects.length}
            />
          ))}
        </div>
      )}
    </section>
  )
}

export default EffectsPanel
