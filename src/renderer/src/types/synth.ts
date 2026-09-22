// 合成器通道的参数，以及几个开箱的声音。
//
// 一个合成器通道发出的声音完全由这里的十个数决定：什么波形、叠几份、偏差多少、包络的
// 四个角、滤波器的三个角。全是扁平的原始值 —— 面板给的是「哪个旋钮动了」，工程文件给的
// 是「这个通道长什么样」，两边都是逐字段的，扁平结构让这两件事共用一条路径。
//
// 单位一律是秒和赫兹，和工程里别的地方一样。这些数字最终会直接写进 AudioParam，中间
// 不再换算，所以这里存的就是音频时钟认识的那个单位。
//
// 这个模块不碰 Web Audio，也不认识通道：它只有数字、边界和夹取。真正把数字变成声音的
// 是 `audio/synth.ts`。

/** 振荡器的波形，也就是 Web Audio 自带的那四种。 */
export type Waveform = 'sine' | 'square' | 'sawtooth' | 'triangle'

/** 滤波器类型，同样是 Web Audio 自带的那几种里挑的三个。 */
export type FilterType = 'lowpass' | 'highpass' | 'bandpass'

/**
 * 一个振荡器还是两个。
 *
 * 两个就是同一个波形叠自己一份，靠 `detuneCents` 错开一点点 —— 加的是厚度，不是新的
 * 谐波。所以这里是个数，不是一个「第二振荡器的波形」字段。
 */
export type OscillatorCount = 1 | 2

export type SynthParams = {
  /** 两个振荡器共用的波形。 */
  waveform: Waveform
  oscCount: OscillatorCount
  /** 第二个振荡器相对第一个偏了多少，音分。100 音分是半音，0 是同度。 */
  detuneCents: number
  /** 起音：从 0 升到满需要的时间。 */
  attackSec: number
  /** 衰减：从满落到延音电平需要的时间。 */
  decaySec: number
  /** 延音：衰减到底之后一直保持的电平，0..1。 */
  sustain: number
  /** 释音：按键松开之后落到 0 需要的时间。 */
  releaseSec: number
  filterType: FilterType
  /** 截止频率。低通和高通就是字面意思；带通是中心频率。 */
  cutoffHz: number
  /** 共振。低通和高通上按分贝读，带通上按线性读 —— 这是 Web Audio 的规矩。 */
  q: number
}

// 面板上旋钮的范围，也是从文件里读回来的参数被夹进的范围。放在这里而不是面板里，
// 是因为这两件事必须是同一组数：一个能被面板拧出来的设置，也必须是文件能存回来的设置。

export const MAX_ENVELOPE_SEC = 2
export const MIN_SUSTAIN = 0
export const MAX_SUSTAIN = 1
export const MIN_DETUNE_CENTS = -100
export const MAX_DETUNE_CENTS = 100
export const MIN_CUTOFF_HZ = 20
export const MAX_CUTOFF_HZ = 20000
export const MIN_Q = 0.1
export const MAX_Q = 20

export const WAVEFORMS: Waveform[] = ['sine', 'square', 'sawtooth', 'triangle']
export const FILTER_TYPES: FilterType[] = ['lowpass', 'highpass', 'bandpass']
export const OSCILLATOR_COUNTS: OscillatorCount[] = [1, 2]

export const WAVEFORM_LABELS: Record<Waveform, string> = {
  sine: '正弦',
  square: '方波',
  sawtooth: '锯齿',
  triangle: '三角'
}

export const FILTER_TYPE_LABELS: Record<FilterType, string> = {
  lowpass: '低通',
  highpass: '高通',
  bandpass: '带通'
}

/**
 * 一个音符号在合成器上的频率。
 *
 * 偏移 0 就是中央 C（MIDI 60），所以键盘上写着 C4 的那个键真的发出 C4。采样器那边没有
 * 根音可依，`noteName` 只能把偏移 0 当作「按原样播」；合成器是自己定音高的，于是偏移
 * 在这里真的成了一个音符号。
 *
 * 指数就是十二平均律：每个半音是 2 的 1/12 次方，A4 是 440Hz，MIDI 69。
 */
export function frequencyForPitch(pitch: number): number {
  return 440 * 2 ** ((pitch - 69 + 60) / 12)
}

/**
 * 一组合法范围内的合成器参数。
 *
 * 面板上的旋钮自己就夹住了范围，但路径不止一条：文件是手写的，改参数的动作是外头调的。
 * 夹取放在这一个地方，于是无论从哪条路进来，音频那边拿到手上的数都是同样的合法。
 * 逐字段来，因为它是扁平的 —— 这里没有嵌套结构要递归。
 */
export function clampSynthParams(params: SynthParams): SynthParams {
  return {
    waveform: params.waveform,
    // 数一数，而不是 `clamp`：它只有 1 和 2 两个合法值，3 该怎么就近处理没有正确答案，
    // 唯一说得通的做法是当它没写。
    oscCount: params.oscCount === 2 ? 2 : 1,
    detuneCents: clamp(params.detuneCents, MIN_DETUNE_CENTS, MAX_DETUNE_CENTS),
    attackSec: clamp(params.attackSec, 0, MAX_ENVELOPE_SEC),
    decaySec: clamp(params.decaySec, 0, MAX_ENVELOPE_SEC),
    sustain: clamp(params.sustain, MIN_SUSTAIN, MAX_SUSTAIN),
    releaseSec: clamp(params.releaseSec, 0, MAX_ENVELOPE_SEC),
    filterType: params.filterType,
    cutoffHz: clamp(params.cutoffHz, MIN_CUTOFF_HZ, MAX_CUTOFF_HZ),
    q: clamp(params.q, MIN_Q, MAX_Q)
  }
}

/**
 * 两组参数是不是同一个设置。
 *
 * 有了它，一次没有改动任何数字的编辑就不算一次编辑，也就不会往撤销栈上放一个空步骤。
 * 逐字段比是因为它是扁平的：一个字段一个 `===`，没有浮点的近似，也没有嵌套。
 */
export function sameSynthParams(a: SynthParams, b: SynthParams): boolean {
  return (
    a.waveform === b.waveform &&
    a.oscCount === b.oscCount &&
    a.detuneCents === b.detuneCents &&
    a.attackSec === b.attackSec &&
    a.decaySec === b.decaySec &&
    a.sustain === b.sustain &&
    a.releaseSec === b.releaseSec &&
    a.filterType === b.filterType &&
    a.cutoffHz === b.cutoffHz &&
    a.q === b.q
  )
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(Math.max(value, min), max)
}

export type SynthPresetId = 'bass' | 'lead' | 'pad' | 'pluck'

export type SynthPreset = {
  id: SynthPresetId
  /** 下拉里显示的名字。 */
  label: string
  /** 一句话说明它想做什么声音，鼠标停上去能看到。 */
  hint: string
  params: SynthParams
}

/**
 * Lead：两个振荡器错开一点点，中频突出，起音干脆。
 *
 * 也是新建合成器通道的起点 —— 它是最能马上听出「这是个合成器」的一档：起音和释音都短到
 * 能跟得上手速，滤波器开在能听见波形的地方，拧任何一个旋钮都会立刻有变化。
 */
const LEAD: SynthParams = {
  waveform: 'sawtooth',
  oscCount: 2,
  detuneCents: 12,
  attackSec: 0.01,
  decaySec: 0.2,
  sustain: 0.7,
  releaseSec: 0.15,
  filterType: 'lowpass',
  cutoffHz: 4000,
  q: 2
}

/**
 * 四个开箱的声音。改的是参数，不是代码 —— 它们就是上面的那十个数的四份取值，
 * 所以换预设和拧旋钮走的是同一条路，撤销栈上也都是同一件事。
 */
export const SYNTH_PRESETS: SynthPreset[] = [
  {
    id: 'bass',
    label: 'Bass',
    hint: '低通压得很低，共振顶出一点位置，起音立刻',
    params: {
      waveform: 'sawtooth',
      oscCount: 1,
      detuneCents: 0,
      attackSec: 0.005,
      decaySec: 0.18,
      sustain: 0.55,
      releaseSec: 0.1,
      filterType: 'lowpass',
      cutoffHz: 600,
      q: 4
    }
  },
  { id: 'lead', label: 'Lead', hint: '两个振荡器微微错开，亮而干脆', params: LEAD },
  {
    id: 'pad',
    label: 'Pad',
    hint: '起音和释音都长，慢进慢出，铺在底下',
    params: {
      waveform: 'sawtooth',
      oscCount: 2,
      detuneCents: 20,
      attackSec: 0.8,
      decaySec: 0.6,
      sustain: 0.85,
      releaseSec: 1.5,
      filterType: 'lowpass',
      cutoffHz: 1200,
      q: 0.7
    }
  },
  {
    id: 'pluck',
    label: 'Pluck',
    hint: '没有延音，弹一下就走，靠释音拖出尾巴',
    params: {
      waveform: 'triangle',
      oscCount: 2,
      detuneCents: -7,
      attackSec: 0.005,
      decaySec: 0.25,
      sustain: 0,
      releaseSec: 0.2,
      filterType: 'lowpass',
      cutoffHz: 3000,
      q: 1.5
    }
  }
]

/** 新建合成器通道的起点：Lead。 */
export const DEFAULT_SYNTH_PARAMS: SynthParams = LEAD
