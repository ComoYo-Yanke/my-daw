// 合成器的发声单元：把一条音符排成一条 振荡器 -> 滤波器 -> 包络 的链子。
//
// 这里没有 Strip 之外的工程概念，也不认识 store —— 和 `engine.ts` 一样是纯 Web Audio。
// 它只做一件事：给定一组合成器参数和一条音符，造出这一条声音，并把它的起止时间交给音频
// 时钟。造出来的东西接到哪里由调用方决定：实时播放接在通道条上，离线渲染接在导出图上，
// 所以录进文件的和耳朵听到的是同一份代码，不会各响各的。
//
// 每条音符一份的图：
//
//   OscillatorNode(1 或 2 个) -> GainNode -> BiquadFilterNode -> GainNode -> (调用方)
//         振荡器                 混合           滤波器            包络
//
// 包络在滤波器之后，这是减法合成一贯的顺序：先决定留下哪些谐波，再决定这个音的形状。
// 振荡器不自己做音量 —— 力度和 ADSR 都在最后那一级增益上乘，只有一处算响度。

import {
  alignToSample,
  gainForVelocity,
  getAudioContext,
  scheduleGainCurve,
  trackVoice,
  VOICE_FADE_OUT_SEC,
  type ChannelStrip,
  type SongNote
} from './engine'
import { soundingSec, type Note } from '../types/note'
import { frequencyForPitch, type SynthParams } from '../types/synth'

/**
 * 两个振荡器之间的音量分配：一个出满，两个各出一半。
 *
 * 不改音量旋钮的读法，也不改别的东西 —— 改的是「叠一份自己」这件事本身的响度。
 * 同度或近同度的两份波形相加会高大约 6dB，不除的话把振荡器从 1 拧到 2 就是在偷偷调音量，
 * 而音量该由音量旋钮说了算。
 */
const MIX_PER_OSCILLATOR = 0.5

/**
 * 释音的最短时间。
 *
 * 音符的门关上时包络必须真的走到 0，而不是「几乎到」—— 半途掐断就是一声咔哒，和采样器
 * 那条淡出要解决的是同一件事，所以下限也用同一个数。用户把 Release 拧到 0 得到的是最短，
 * 不是一个跳变。
 */
const MIN_RELEASE_SEC = VOICE_FADE_OUT_SEC

/**
 * 起音的最短时间，理由和上面一样，方向相反：从 0 一帧之内跳到峰值同样是咔哒。
 * Attack 拧到 0 得到的是 5ms 的开门时间，听感上就是「立刻」。
 */
const MIN_ATTACK_SEC = 0.005

/**
 * 一条声音在释音走完之后还留的余量，用来决定振荡器什么时候停。
 *
 * 释音结束时包络已经是 0，再往后就没有声音了；这一点点只是为了让 `stop()` 落在静音之后，
 * 而不是正好卡在归零的那一帧上。
 */
const VOICE_TAIL_SEC = 0.01

/** 包络上的一个拐点：从音符起点算起的时间，和 0..1 的电平。 */
export type EnvelopePoint = {
  atSec: number
  value: number
}

/**
 * 包络在门内某个时刻的电平，0..1。
 *
 * 它回答的是「门在这一刻关掉的话，包络正走到哪」—— 一个短音符的释音必须从它当时所在的
 * 高度往下滑，而不是从延音电平开始。三段各自线性：起音是从 0 到 1，衰减是从 1 到延音，
 * 之后一直停在延音上。
 *
 * 衰减为 0 时 `t >= 起音` 直接给出延音电平，读作「没有衰减这一腿，起音一路升到延音」，
 * 这也正是听感上该有的样子。
 */
function envelopeValueAt(env: SynthParams, atSec: number): number {
  if (atSec <= 0) return 0

  const attackSec = Math.max(env.attackSec, MIN_ATTACK_SEC)
  if (atSec < attackSec) return atSec / attackSec

  const sinceAttackSec = atSec - attackSec
  if (env.decaySec > 0 && sinceAttackSec < env.decaySec) {
    return 1 + (env.sustain - 1) * (sinceAttackSec / env.decaySec)
  }
  return env.sustain
}

/**
 * 一条 ADSR 的形状：从 0 起，经过起音的顶和衰减的落点，平走到门的尽头，再由释音回到 0。
 *
 * 面板画的是它，调度器写的也是它 —— 图上看到的形状就是听到的形状，两者不会各说各话。
 * 门比「起音 + 衰减」还短的时候，拐点被截在门上，图上那段斜坡跟着变短，和声音一致。
 *
 * 时间是相对音符起点的秒数，电平是 0..1 的比值，都还没乘力度：这是包络本身的样子，
 * 与这一条音符弹得多重无关。
 */
export function envelopePoints(env: SynthParams, gateSec: number): EnvelopePoint[] {
  const gate = Math.max(gateSec, 0)
  const attackSec = Math.max(env.attackSec, MIN_ATTACK_SEC)
  const releaseSec = Math.max(env.releaseSec, MIN_RELEASE_SEC)
  const decayEndSec = attackSec + env.decaySec

  const raw: EnvelopePoint[] = [
    { atSec: 0, value: 0 },
    { atSec: Math.min(attackSec, gate), value: envelopeValueAt(env, Math.min(attackSec, gate)) },
    { atSec: Math.min(decayEndSec, gate), value: envelopeValueAt(env, Math.min(decayEndSec, gate)) }
  ]
  // 门在包络走完之前就关了：延音那一段平线根本不存在，也就没有点要画。
  if (decayEndSec < gate) raw.push({ atSec: gate, value: env.sustain })
  raw.push({ atSec: gate + releaseSec, value: 0 })

  // 衰减为 0 或者门极短的时候，上面会有两三个点落在同一时刻 —— 那些是零长度的一段，
  // 不是拐点。同一个时刻只留最后一个值，它就变成了一段没有中间停顿的斜坡。
  const points: EnvelopePoint[] = []
  for (const point of raw) {
    const last = points[points.length - 1]
    if (last !== undefined && point.atSec <= last.atSec) {
      last.value = point.value
      continue
    }
    points.push({ atSec: point.atSec, value: point.value })
  }
  return points
}

/**
 * 把一条包络写到增益上。
 *
 * `peak` 是这条声音的最高电平 —— 力度在这里乘进去，而不是另起一级增益：对合成器来说
 * 包络本身就是它的振幅，力度是包络的高度，两者是同一个数上的两步，没有分开的理由。
 *
 * 事件全是相对的：`points` 的时间相对音符起点，所以离线渲染可以直接把音符在歌曲里的
 * 绝对位置传进来，写出来的斜坡和实时播放的一模一样。
 */
function scheduleEnvelope(
  param: AudioParam,
  points: EnvelopePoint[],
  peak: number,
  atSec: number
): void {
  const first = points[0]
  param.setValueAtTime(first.value * peak, atSec)
  for (let index = 1; index < points.length; index += 1) {
    const point = points[index]
    param.linearRampToValueAtTime(point.value * peak, atSec + point.atSec)
  }
}

/** 一条合成器声音造出来的节点，以及它什么时候结束。 */
export type SynthVoice = {
  /** 第一个振荡器：它是这条声音的「源头」，`trackVoice` 认的就是它。 */
  source: AudioScheduledSourceNode
  /** 这条声音独占的节点，声音结束或被切掉时一起摘掉。 */
  tail: AudioNode[]
  /** 接到别处去的那个节点，也就是包络的输出。 */
  output: AudioNode
}

/**
 * 造一条合成器声音，并把它的起止时间排进 `context` 的时钟。
 *
 * `context` 是 `BaseAudioContext` 而不是 `AudioContext`：实时和离线两个上下文都能进这里，
 * 这正是导出能和播放一致的原因。`atSec` 用哪个时钟，由传进来的上下文决定。
 *
 * 整条链子全是定值，只有包络在动。截止频率和 Q 说的是这条声音的音色，不是一个随时间变化
 * 的形状，所以它们不走自动化 —— 也因此拧滤波器旋钮是在改下一个音，正在响的那条不受影响，
 * 和硬件合成器一样。
 */
export function buildSynthVoice(
  context: BaseAudioContext,
  params: SynthParams,
  note: Note,
  atSec: number
): SynthVoice {
  // 门和起点都先对齐到采样点。`atSec` 是调用方的时钟（实时是 `currentTime`，离线是歌
  // 曲开头的秒数），两个上下文各自对齐一次，同一个音符在两边的落点就是同一个采样点。
  const startSec = alignToSample(atSec, context.sampleRate)
  // 门的长度就是音符听起来的那一段：画出来的长度加上它带的尾音。和采样器同一条规矩
  // （见 `soundingSec`），所以同一个 Pattern 里的两种通道在时间上是对齐的。
  const gateSec = alignToSample(soundingSec(note), context.sampleRate)
  const releaseSec = Math.max(params.releaseSec, MIN_RELEASE_SEC)
  // 尾巴那两项不对齐：振荡器停在包络早就归零之后，落在哪儿都不影响声音。
  const endSec = startSec + gateSec + releaseSec + VOICE_TAIL_SEC

  const mix = context.createGain()
  mix.gain.value = params.oscCount === 2 ? MIX_PER_OSCILLATOR : 1

  const filter = context.createBiquadFilter()
  filter.type = params.filterType
  filter.frequency.value = params.cutoffHz
  filter.Q.value = params.q
  mix.connect(filter)

  const envelope = context.createGain()
  const points = envelopePoints(params, gateSec)
  scheduleEnvelope(envelope.gain, points, gainForVelocity(note.velocity), startSec)
  filter.connect(envelope)

  const frequency = frequencyForPitch(note.pitch)
  const oscillators: OscillatorNode[] = []
  for (let index = 0; index < params.oscCount; index += 1) {
    const oscillator = context.createOscillator()
    oscillator.type = params.waveform
    oscillator.frequency.value = frequency
    // 失谐只给第二个振荡器：音高由音符决定，第一个永远站在音高上，偏差加的是厚度。
    oscillator.detune.value = index === 0 ? 0 : params.detuneCents
    oscillator.connect(mix)
    oscillators.push(oscillator)
  }

  // 两个振荡器各自排自己的起止，但时间完全一样，听不出是两个源头。
  for (const oscillator of oscillators) {
    oscillator.start(startSec)
    oscillator.stop(endSec)
  }

  return {
    source: oscillators[0],
    tail: [...oscillators.slice(1), mix, filter, envelope],
    output: envelope
  }
}

/**
 * 把一个合成器通道排到一段音符上。
 *
 * 和 `scheduleNoteSequence` 是同一条规矩：每一条声音都带着自己的起止时间交给音频时钟，
 * 所以重叠的音符同时响，和弦就是和弦；结束由最后一条声音的 `onended` 报回来，不是靠计时器
 * 去猜。名字里没有 `play` 是因为它不切断已经在响的声音 —— 步进循环和卷帘循环要靠它接上
 * 下一圈，停一下就是每圈一个缺口。
 *
 * 收的是 `SongNote`，因为整曲的通道也会走到这里：一条音符带着它所在片段的音量曲线，曲线
 * 就得跟着它一起进来。接法和采样器一样 —— 曲线是独立一级增益上的形状，和包络相乘，
 * 而不是替掉包络。
 */
export function scheduleSynthSequence(
  strip: ChannelStrip,
  params: SynthParams,
  notes: SongNote[],
  startAtSec: number,
  onFinished?: () => void
): void {
  const context = getAudioContext()
  const ordered = [...notes]
    .filter((note) => note.lengthSec > 0)
    .sort((a, b) => a.startSec - b.startSec)
  if (ordered.length === 0) return

  // 报信的是最后 *停* 的那一条，而不是最后 *开始* 的那一条：合成器的每条声音长多少由包络
  // 和门决定，先开始的完全可能后结束（`scheduleNoteSequence` 那边按开始顺序取，因为采样
  // 什么时候放完是采样自己的事）。这里能算得出来，就不猜。
  const releaseSec = Math.max(params.releaseSec, MIN_RELEASE_SEC)
  let lastIndex = 0
  let lastEndSec = -Infinity
  ordered.forEach((note, index) => {
    const endSec = note.startSec + soundingSec(note) + releaseSec
    if (endSec > lastEndSec) {
      lastEndSec = endSec
      lastIndex = index
    }
  })

  ordered.forEach((note, index) => {
    const noteStartSec = startAtSec + note.startSec
    const voice = buildSynthVoice(context, params, note, noteStartSec)

    const curve = note.curve
    const curveOffsetSec = note.curveOffsetSec
    if (curve !== undefined && curve.length > 0 && curveOffsetSec !== undefined) {
      const automation = context.createGain()
      scheduleGainCurve(automation.gain, curve, curveOffsetSec, noteStartSec, note.lengthSec)
      voice.output.connect(automation)
      automation.connect(strip.input)
      voice.tail.push(automation)
    } else {
      voice.output.connect(strip.input)
    }

    trackVoice(strip, voice.source, index === lastIndex ? onFinished : undefined, voice.tail)
  })
}

/**
 * 一个滤波器设置在频率轴上的样子，用来画那条响应曲线。
 *
 * 借一个真的 `BiquadFilterNode` 来算，而不是在这里重写一遍双二阶的公式：Web Audio 的 Q
 * 在低通和高通上是分贝、在带通上是线性，手写一份迟早会和它听起来的不一样，而图的作用正是
 * 说清楚「待会儿会听到什么」。
 *
 * 节点是现造的，没有接到任何地方去，所以不发声，也不会被回收之外的任何东西看见。
 */
export function filterResponse(
  params: SynthParams,
  // `Float32Array<ArrayBuffer>` rather than a bare `Float32Array`: the DOM types
  // insist on a buffer that is not shared, and a bare one is the whole family.
  frequencies: Float32Array<ArrayBuffer>
): Float32Array {
  const filter = getAudioContext().createBiquadFilter()
  filter.type = params.filterType
  filter.frequency.value = params.cutoffHz
  filter.Q.value = params.q

  const magnitude = new Float32Array(frequencies.length)
  const phase = new Float32Array(frequencies.length)
  filter.getFrequencyResponse(frequencies, magnitude, phase)
  return magnitude
}
