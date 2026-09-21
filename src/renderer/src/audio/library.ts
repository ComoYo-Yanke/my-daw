// 内置采样库：一台不需要任何文件的鼓机兼音源。
//
// 大部分采样不是磁盘上的 WAV，而是几个合成函数的输出。理由很直接：仓库里不放二进制，
// 工程文件也不用背着一堆音频 —— 一个内置采样的身份就是它的伪路径
// （`library://drums/kick/808`）。打开工程时按同一个函数重新合成，听到的还是同一个
// 声音。
//
// 所以每个合成函数都必须是确定性的：噪声用固定种子的伪随机，而不是 Math.random，
// 否则同一个工程每打开一次，鼓的音色都会变一点。
//
// 合成在首次用到时做一次，结果缓存在这里。AudioBuffer 是不可变的，所以一个采样被
// 多个通道共享是安全的 —— 和导入的采样走的是同一套。
//
// 例外是三角钢琴：它是真录音，30 个文件躺在 resources/samples 里跟着应用走。理由是
// 合成不出来 —— 弦的不谐和性、槌子和音板的耦合能写出个大概，但听得出是假的。这一
// 类采样按文件加载，加载完和合成的那批长得一样（见 `LibraryZone`）。

import { decodeAudioData, getAudioContext, toArrayBuffer } from './engine'
import type { SampleZone } from '../types/sample'

/** 内置采样的伪路径前缀。工程文件靠它区分磁盘文件和库里合成出来的东西。 */
export const LIBRARY_SCHEME = 'library://'

/** 合成一个采样需要知道的东西。 */
type SynthContext = {
  sampleRate: number
  /** 由路径派生，固定不变，用来喂噪声发生器。 */
  seed: number
}

/** 一个合成函数：交出整段单声道 PCM，长度和内容都由它的参数决定。 */
type Synth = (context: SynthContext) => Float32Array

/**
 * 真录音采样里的一份录音：它是哪个音，以及文件放在哪。
 *
 * `file` 是相对 `resources/samples` 的路径。打包之后这一层目录是主进程去读的，
 * 渲染进程拿到的只是解好的音频。
 */
export type LibraryZone = {
  /** 这份录音自己的音高，半音数，0 = 采样自己的基准音（卷帘把它叫 C4）。 */
  pitch: number
  file: string
}

/** 代码合成的采样：一个函数交出整段 PCM。 */
type SynthSource = { synth: Synth }

/** 打包进来的采样：一段音域一份录音，二选一。 */
type FileSource = { zones: LibraryZone[] }

/**
 * 一个内置采样。
 *
 * 两种来源二选一：合成的，或者文件。对上层不是一回事 —— 加载方式差得远 —— 但对
 * 播放是一回事：两种都会得到一张音域表（`SampleZone`），引擎照单收下。
 */
export type LibrarySample = {
  /** 伪路径，也是工程文件里存的东西。 */
  path: string
  name: string
  /**
   * 峰值电平，0..1。
   *
   * 库内部的一个粗混音：不这么做的话每个采样都会被归一化到同一个峰值，踩镲会和
   * 底鼓一样响。通道自己的音量仍然可以再拧。
   *
   * 合成的采样是「归一化到这个峰值」；文件采样按原样录进去的，这里是直接乘上去的
   * 增益，1 就是不动它。
   */
  level: number
} & (SynthSource | FileSource)

/** 一个子分组。只有鼓组真的用得上，吉他和钢琴是一个 label 为空的平铺分组。 */
type LibraryGroup = {
  id: string
  label: string
  samples: LibrarySample[]
}

type LibraryCategory = {
  id: string
  label: string
  groups: LibraryGroup[]
}

/**
 * Salamander 三角钢琴的文件清单。
 *
 * 上游是按小三度一个一个录的，从 A0 到 C8 正好 30 个，所以这里只列音名，音高由
 * 位置推出来 —— 30 行写死的数字就是 30 次打错的机会，而一个错的音高不会报错，
 * 只会让那一段音域听起来不对劲。
 *
 * `Ds` 是升 D，`Fs` 是升 F：上游的写法，不是笔误。
 */
const SALAMANDER_FILES = [
  'A0',
  'C1',
  'Ds1',
  'Fs1',
  'A1',
  'C2',
  'Ds2',
  'Fs2',
  'A2',
  'C3',
  'Ds3',
  'Fs3',
  'A3',
  'C4',
  'Ds4',
  'Fs4',
  'A4',
  'C5',
  'Ds5',
  'Fs5',
  'A5',
  'C6',
  'Ds6',
  'Fs6',
  'A6',
  'C7',
  'Ds7',
  'Fs7',
  'A7',
  'C8'
]

/** A0 的音高，相对采样自己的基准音 C4。 */
const SALAMANDER_FIRST_PITCH = -39

/** 相邻两份录音差几个半音。 */
const SALAMANDER_STEP = 3

const SALAMANDER_ZONES: LibraryZone[] = SALAMANDER_FILES.map((name, index) => ({
  pitch: SALAMANDER_FIRST_PITCH + index * SALAMANDER_STEP,
  file: `salamander/${name}.mp3`
}))

/**
 * 库的分类树，也是侧边栏画的东西。
 *
 * 鼓组按鼓件分子组 —— FL 的通道架就是这么分的，找底鼓的时候不用在一堆名字里翻。
 */
export const LIBRARY: LibraryCategory[] = [
  {
    id: 'drums',
    label: 'Drums',
    groups: [
      {
        id: 'kick',
        label: 'Kick',
        samples: [
          {
            path: 'library://drums/kick/808',
            name: '808 Kick',
            level: 1,
            synth: kick(120, 45, 0.45, 0.06)
          },
          {
            path: 'library://drums/kick/tight',
            name: 'Tight Kick',
            level: 0.95,
            synth: kick(180, 60, 0.16, 0.03)
          },
          {
            path: 'library://drums/kick/deep',
            name: 'Deep Kick',
            level: 1,
            synth: kick(90, 35, 0.7, 0.09)
          }
        ]
      },
      {
        id: 'snare',
        label: 'Snare',
        samples: [
          {
            path: 'library://drums/snare/noise',
            name: 'Noise Snare',
            level: 0.85,
            synth: snare(190, 0.18, 0.09)
          },
          {
            path: 'library://drums/snare/tight',
            name: 'Tight Snare',
            level: 0.85,
            synth: snare(240, 0.1, 0.05)
          },
          {
            path: 'library://drums/snare/rim',
            name: 'Rim Snare',
            level: 0.8,
            synth: snare(400, 0.05, 0.03)
          }
        ]
      },
      {
        id: 'hihat',
        label: 'Hi-hat',
        samples: [
          {
            path: 'library://drums/hihat/closed',
            name: 'Closed Hat',
            level: 0.45,
            synth: hihat(0.045)
          },
          {
            path: 'library://drums/hihat/open',
            name: 'Open Hat',
            level: 0.4,
            synth: hihat(0.34)
          },
          {
            path: 'library://drums/hihat/pedal',
            name: 'Pedal Hat',
            level: 0.45,
            synth: hihat(0.09)
          }
        ]
      },
      {
        id: 'clap',
        label: 'Clap',
        samples: [
          {
            path: 'library://drums/clap/clap',
            name: 'Clap',
            level: 0.6,
            synth: clap(3, 0.011, 0.16)
          },
          {
            path: 'library://drums/clap/wide',
            name: 'Wide Clap',
            level: 0.6,
            synth: clap(4, 0.017, 0.28)
          }
        ]
      }
    ]
  },
  {
    id: 'guitar',
    label: 'Guitar',
    groups: [
      {
        id: 'guitar',
        label: '',
        samples: [
          {
            path: 'library://guitar/nylon',
            name: 'Nylon Pluck',
            level: 0.8,
            synth: pluck(196, 0.996, 2200, 1.6)
          },
          {
            path: 'library://guitar/steel',
            name: 'Steel Pluck',
            level: 0.8,
            synth: pluck(246.94, 0.998, 4200, 2)
          },
          {
            path: 'library://guitar/mute',
            name: 'Palm Mute',
            level: 0.8,
            synth: pluck(146.83, 0.986, 1400, 0.7)
          }
        ]
      }
    ]
  },
  {
    id: 'piano',
    label: 'Piano',
    groups: [
      {
        id: 'piano',
        label: '',
        samples: [
          {
            path: 'library://piano/salamander',
            name: 'Salamander Grand',
            // 不归一化：低音区和高音区本来就不是一样响的，把 30 段录音各自拉到同一
            // 个峰值会把这个差别抹掉，而那正是钢琴的一部分。
            level: 1,
            zones: SALAMANDER_ZONES
          },
          {
            path: 'library://piano/concert',
            name: 'Concert Grand',
            // 比另外三个高一点：它的峰值是开头那一下三根弦同相的瞬间，之后靠拍打
            // 散开，撑住的那一段比峰值低一截。归一化只看峰值，所以这里得补回来。
            level: 0.9,
            synth: grandPiano(261.63, 3, 0.0004, 10)
          },
          {
            path: 'library://piano/grand',
            name: 'Grand Piano',
            level: 0.8,
            synth: piano(261.63, 2.2, 8)
          },
          {
            path: 'library://piano/soft',
            name: 'Soft Piano',
            level: 0.8,
            synth: piano(220, 2.6, 5)
          },
          {
            path: 'library://piano/electric',
            name: 'Electric Piano',
            level: 0.8,
            synth: piano(261.63, 1.4, 4)
          }
        ]
      }
    ]
  }
]

/** 路径 -> 库记录。侧边栏和打开工程时都从这里查。 */
const BY_PATH = new Map<string, LibrarySample>(
  LIBRARY.flatMap((category) => category.groups.flatMap((group) => group.samples)).map((sample) => [
    sample.path,
    sample
  ])
)

/** 加载好的音域表，按路径缓存。 */
const rendered = new Map<string, SampleZone[]>()

/** 这个路径是不是一个内置采样 —— 合成的和打包进来的都算。 */
export function isLibraryPath(path: string): boolean {
  return path.startsWith(LIBRARY_SCHEME)
}

/** 一个内置采样，加载好之后的样子。 */
export type LoadedLibrarySample = {
  sample: LibrarySample
  zones: SampleZone[]
}

/**
 * 取一个内置采样，第一次用到时加载。
 *
 * 缓存不是优化而是必须的：一个采样可能被好几个通道用着，而每次点一下都重新合成几
 * 秒钟的 PCM、或者重新读盘解码三十个文件，会明显卡一下。
 *
 * 两种来源在这里合流：往下走一步之后，「合成的」和「打包的」就没有区别了，都是一
 * 张音域表。上层不必知道手里这个采样是从哪来的。
 *
 * 路径不在库里时返回 null —— 打开一份工程时这是「这个采样丢了」，不是崩溃的理由。
 * 打包的采样一个文件都读不回来时也是 null，理由一样。
 */
export async function loadLibrarySample(path: string): Promise<LoadedLibrarySample | null> {
  const sample = BY_PATH.get(path)
  if (sample === undefined) return null

  const cached = rendered.get(path)
  if (cached !== undefined) return { sample, zones: cached }

  const zones = 'synth' in sample ? renderSynth(sample) : await renderBundled(sample)
  if (zones === null) return null

  rendered.set(path, zones)
  return { sample, zones }
}

/**
 * 合成的那个：算一遍就是结果。
 *
 * 只有一段音域，在 0 —— 也就是说每个音都靠变调到位，这正是它一直以来的行为。
 */
function renderSynth(sample: LibrarySample & SynthSource): SampleZone[] {
  const context = getAudioContext()
  const data = sample.synth({ sampleRate: context.sampleRate, seed: pathSeed(sample.path) })
  normalize(data, sample.level)

  const buffer = context.createBuffer(1, data.length, context.sampleRate)
  // `set` rather than `copyToChannel`: the two do the same thing, and this one
  // does not care which kind of backing buffer the array came out of.
  buffer.getChannelData(0).set(data)
  return [{ pitch: 0, buffer }]
}

/**
 * 打包进来的那个：把清单上的文件读一遍、解一遍。
 *
 * 少一个文件不致命 —— 那一段音域空着，附近的音落到别的录音上，琴还是能弹。一个都
 * 没读回来才算这个采样没了。
 *
 * 解码一起发出去，不排队：它们之间没有任何先后关系，串行等三十个文件的好几个来回
 * 是白等的。
 */
async function renderBundled(sample: LibrarySample & FileSource): Promise<SampleZone[] | null> {
  const files = await window.api.readBundledSamples(sample.zones.map((zone) => zone.file))
  const dataByFile = new Map(files.map((file) => [file.path, file.data]))

  const decoded = await Promise.all(
    sample.zones.map(async (zone): Promise<SampleZone | null> => {
      const data = dataByFile.get(zone.file)
      if (data === undefined) return null
      try {
        const buffer = await decodeAudioData(toArrayBuffer(data))
        // 不归一化：`normalize` 会把每段录音都拉到同一个峰值，而低音区和高音区本来
        // 就不是一样响的。`level` 是库内部再拧一点的那一下，1 就是不动它。
        if (sample.level !== 1) scaleBuffer(buffer, sample.level)
        return { pitch: zone.pitch, buffer }
      } catch {
        // 读到了但解不开 —— 截断的文件，或者根本不是音频。按没读到算。
        return null
      }
    })
  )

  const zones = decoded.filter((zone): zone is SampleZone => zone !== null)
  return zones.length === 0 ? null : zones
}

// 合成工具
//
// 下面这些都只写 Float32Array，不碰 Web Audio 的图：合成是离线算一遍写进缓冲，不是
// 挂在实时图上跑，所以滤波也是自己算的。一阶的斜率对做采样够用。

/** 一段 `seconds` 秒的 PCM 有多少帧。 */
function frames(sampleRate: number, seconds: number): number {
  return Math.max(1, Math.round(sampleRate * seconds))
}

/**
 * 固定种子的伪随机数，-1..1。
 *
 * 不是 Math.random：内置采样要在每次打开工程时重新合成出同一个声音，而噪声的音色
 * 完全由这串数决定。
 */
function noiseSource(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return (((value ^ (value >>> 14)) >>> 0) / 4294967296) * 2 - 1
  }
}

/** FNV-1a：路径 -> 种子，同一个采样每次合成都用同一串噪声。 */
function pathSeed(path: string): number {
  let hash = 2166136261
  for (let index = 0; index < path.length; index += 1) {
    hash ^= path.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

/** 一阶高通。镲片和军鼓的“沙”都在高频，低频得砍掉。 */
function highPass(data: Float32Array, cutoffHz: number, sampleRate: number): void {
  const rc = 1 / (2 * Math.PI * cutoffHz)
  const dt = 1 / sampleRate
  const alpha = rc / (rc + dt)
  let previousInput = 0
  let previousOutput = 0
  for (let index = 0; index < data.length; index += 1) {
    const input = data[index]
    previousOutput = alpha * (previousOutput + input - previousInput)
    previousInput = input
    data[index] = previousOutput
  }
}

/** 一阶低通。 */
function lowPass(data: Float32Array, cutoffHz: number, sampleRate: number): void {
  const rc = 1 / (2 * Math.PI * cutoffHz)
  const dt = 1 / sampleRate
  const alpha = dt / (rc + dt)
  let previous = 0
  for (let index = 0; index < data.length; index += 1) {
    previous += alpha * (data[index] - previous)
    data[index] = previous
  }
}

/**
 * 起音斜坡，秒。
 *
 * 够短，听不出音头被磨圆；够长，不至于让波形从零一步跳起来，“啪”一声。
 */
const ATTACK_SEC = 0.0015

function attackGain(tSec: number, attackSec = ATTACK_SEC): number {
  return tSec >= attackSec ? 1 : tSec / attackSec
}

/**
 * 结尾淡出，秒。
 *
 * 放着不管的话，波形会在振幅还很大的地方被一刀切断，切的那一下就是一个爆音 ——
 * 听起来像每个采样末尾都跟着一声咔哒。
 */
function fadeOut(data: Float32Array, sampleRate: number, fadeSec = 0.01): void {
  const count = Math.min(data.length, Math.round(fadeSec * sampleRate))
  for (let index = 0; index < count; index += 1) {
    data[data.length - 1 - index] *= index / count
  }
}

/** 把峰值拉到 `level`，让库里每个采样落在它该在的响度上。 */
function normalize(data: Float32Array, level: number): void {
  let peak = 0
  for (const value of data) {
    peak = Math.max(peak, Math.abs(value))
  }
  if (peak === 0) return
  const scale = level / peak
  for (let index = 0; index < data.length; index += 1) {
    data[index] *= scale
  }
}

/**
 * 整段乘一个增益。
 *
 * `level` 对合成采样是「归一化到哪」，对文件采样只能是这样乘一下 —— 录音的峰值不
 * 是这里定的，也不该被这里改掉。
 */
function scaleBuffer(buffer: AudioBuffer, gain: number): void {
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel)
    for (let index = 0; index < data.length; index += 1) {
      data[index] *= gain
    }
  }
}

// 合成器
//
// 每个都是一个工厂：参数写死在库表里，函数本身只认采样率。它们不需要知道自己是
// 谁的音色，也不需要知道缓存 —— 那是上面的事。

/**
 * 底鼓：一个正弦，音高从 `startHz` 迅速滑到 `endHz`，振幅指数衰减。
 *
 * 下滑的那一段就是底鼓的“打”：纯粹的 45Hz 正弦听起来只是嗡嗡，前 60 毫秒里从
 * 120Hz 滑下来才有敲击感。
 */
function kick(startHz: number, endHz: number, decaySec: number, sweepSec: number): Synth {
  return ({ sampleRate }) => {
    // 五个时间常数之后振幅只剩千分之几，再往后就是浪费帧。
    const data = new Float32Array(frames(sampleRate, decaySec * 5))
    let phase = 0
    for (let index = 0; index < data.length; index += 1) {
      const tSec = index / sampleRate
      const hz = endHz + (startHz - endHz) * Math.exp(-tSec / sweepSec)
      // 频率一直在变，相位只能自己积分。直接算 sin(2πft) 会在扫频时走音。
      phase += (2 * Math.PI * hz) / sampleRate
      data[index] = Math.sin(phase) * Math.exp(-tSec / decaySec) * attackGain(tSec)
    }
    fadeOut(data, sampleRate)
    return data
  }
}

/**
 * 军鼓：噪声的“沙”加上一个音高明确的鼓皮音。
 *
 * 两个部分各走各的衰减：鼓皮短促，沙响长一点，合起来才是军鼓从“咔”到“沙”的
 * 那个形状。
 */
function snare(toneHz: number, noiseDecaySec: number, toneDecaySec: number): Synth {
  return ({ sampleRate, seed }) => {
    const noise = noiseSource(seed)
    const data = new Float32Array(frames(sampleRate, Math.max(noiseDecaySec, toneDecaySec) * 5))
    const body = new Float32Array(data.length)
    let phase = 0
    for (let index = 0; index < data.length; index += 1) {
      const tSec = index / sampleRate
      const envelope = attackGain(tSec)
      phase += (2 * Math.PI * toneHz) / sampleRate
      body[index] = Math.sin(phase) * Math.exp(-tSec / toneDecaySec) * envelope
      data[index] = noise() * Math.exp(-tSec / noiseDecaySec) * envelope
    }
    // 噪声留在高频、鼓皮留在低频，两边不打架，响度也才叠得起来。
    highPass(data, toneHz * 1.5, sampleRate)
    for (let index = 0; index < data.length; index += 1) {
      data[index] += body[index]
    }
    fadeOut(data, sampleRate)
    return data
  }
}

/**
 * 踩镲：高通白噪声，衰减时间决定它是闭镲、半开的踏镲还是开镲。
 *
 * 砍两次是因为一阶高通只滚 6dB/倍频程，一次留下的低频还够让它听起来像噪声鼓。
 */
function hihat(decaySec: number): Synth {
  return ({ sampleRate, seed }) => {
    const noise = noiseSource(seed)
    const data = new Float32Array(frames(sampleRate, decaySec * 5))
    for (let index = 0; index < data.length; index += 1) {
      data[index] = noise() * Math.exp(-index / sampleRate / decaySec)
    }
    highPass(data, 6000, sampleRate)
    highPass(data, 6000, sampleRate)
    fadeOut(data, sampleRate, 0.004)
    return data
  }
}

/**
 * 拍手：几下短促的噪声拍在一起，再加一条长一点的尾巴。
 *
 * 单独的噪声脉冲听起来像枪声；几个错开十来毫秒的脉冲才是“一群人拍手”的那点粗糙感。
 */
function clap(bursts: number, spacingSec: number, tailSec: number): Synth {
  return ({ sampleRate, seed }) => {
    const noise = noiseSource(seed)
    const data = new Float32Array(frames(sampleRate, tailSec * 4))
    const burstDecaySec = 0.012
    for (let index = 0; index < data.length; index += 1) {
      const tSec = index / sampleRate
      let envelope = Math.exp(-tSec / tailSec) * 0.5
      for (let burst = 0; burst < bursts; burst += 1) {
        const sinceBurstSec = tSec - burst * spacingSec
        if (sinceBurstSec >= 0) {
          envelope += Math.exp(-sinceBurstSec / burstDecaySec)
        }
      }
      data[index] = noise() * envelope
    }
    // 拍手的能量集中在中频，两头都削掉。
    highPass(data, 900, sampleRate)
    lowPass(data, 5000, sampleRate)
    fadeOut(data, sampleRate)
    return data
  }
}

/**
 * 拨弦：Karplus-Strong。
 *
 * 一段噪声灌进延时线里来回平均，出来的就是一声弦：延时线的长度定音高，每次绕回来
 * 平均一次就是弦在耗散高频，于是高音先掉、音头亮而后尾暖。比加法合成便宜得多，
 * 也比它像吉他。
 */
function pluck(hz: number, damping: number, brightnessHz: number, lengthSec: number): Synth {
  return ({ sampleRate, seed }) => {
    const data = new Float32Array(frames(sampleRate, lengthSec))
    const size = Math.max(2, Math.round(sampleRate / hz))
    const line = new Float32Array(size)
    const noise = noiseSource(seed)
    for (let index = 0; index < size; index += 1) {
      line[index] = noise()
    }
    // 激励里剩多少高频，决定了这一下拨得有多“亮”。这也正是拨片和指甲的区别。
    lowPass(line, brightnessHz, sampleRate)

    let index = 0
    let previous = line[size - 1]
    for (let frame = 0; frame < data.length; frame += 1) {
      const current = line[index]
      data[frame] = current * attackGain(frame / sampleRate)
      line[index] = (current + previous) * 0.5 * damping
      previous = current
      index = (index + 1) % size
    }
    fadeOut(data, sampleRate, 0.02)
    return data
  }
}

/**
 * 钢琴：一串谐波叠起来，每个谐波自己衰减。
 *
 * 高次谐波衰减得比基频快，所以音头是亮的、尾巴是圆 —— 这是钢琴听上去像钢琴的主要
 * 原因。振幅按 1/n^1.6 摊，比 1/n 暗一点，不那么像风琴。
 *
 * 这是简化版：泛音是精确的整数倍，一个音只有一根弦，也没有槌子。`grandPiano` 补的
 * 就是这四件事。
 */
function piano(hz: number, decaySec: number, harmonics: number): Synth {
  return ({ sampleRate }) => {
    const data = new Float32Array(frames(sampleRate, decaySec * 2.5))
    for (let index = 0; index < data.length; index += 1) {
      const tSec = index / sampleRate
      let value = 0
      for (let harmonic = 1; harmonic <= harmonics; harmonic += 1) {
        const partialDecaySec = decaySec / harmonic ** 0.7
        value +=
          (Math.sin(2 * Math.PI * hz * harmonic * tSec) / harmonic ** 1.6) *
          Math.exp(-tSec / partialDecaySec)
      }
      // 音头的斜坡比别处长一点：钢琴的起音本来就不是一瞬间的事。
      data[index] = value * attackGain(tSec, 0.003)
    }
    fadeOut(data, sampleRate, 0.03)
    return data
  }
}

// 三角钢琴的几个常数。
//
// 写死在这里而不是做成参数，是因为它们换一个值就不再是三角钢琴了：`piano` 的参数
// 是拿来区分三种不同音色的，下面这些不是音色选项，是同一件乐器的事实。

/**
 * 一个音有几根弦，以及它们各自偏离音高多少音分。
 *
 * 中间那根是准的，两边各差 3 音分。真实的调律会把同音弦调到 1 音分以内，这里故意
 * 拉开一点：三根弦差得越多拍得越快，而拍打正是长音在响的过程里一直在动的原因 ——
 * 太准了反而死板。
 */
const GRAND_STRINGS_CENTS = [-3, 0, 3]

/**
 * 两段衰减的比例。
 *
 * 前一段占 `PROMPT_MIX` 的份量，时间常数是后一段的 1/`PROMPT_RATIO`。真实钢琴的振幅
 * 一开始掉得很快，然后换成一个慢得多的尾巴接着走：只有一段指数衰减的话，听上去像
 * 电子琴的持续音，而不是一根被敲响之后还在响的弦。
 */
const PROMPT_MIX = 0.45
const PROMPT_RATIO = 5

/** 槌击噪声的长度，秒。 */
const HAMMER_SEC = 0.02

/**
 * 槌击噪声相对音色主体的响度。
 *
 * 真实钢琴里它就是很轻的一下。调到听得见噪声本身就已经过了 —— 它该做的是让音头听
 * 起来是“敲”出来的，而不是自己成为一个声音。
 */
const HAMMER_MIX = 0.25

/**
 * 三角钢琴：在 `piano` 的谐波堆上补四件真钢琴才有的事。
 *
 * 原来那个 `piano` 是一串精确的整数倍谐波，所以听起来更接近风琴或者玻璃 —— 缺的
 * 不是泛音数量，是下面这四件，而它们各自负责“像钢琴”的一部分：
 *
 * 1. 弦是硬的，泛音因此不是基频的整数倍，而是被往上撑开的（fₙ = n·f₀·√(1+B·n²)）。
 *    这一条最要紧：整数倍泛音听起来是一个音高，被撑开的泛音听起来是一件乐器。
 * 2. 一个音是几根弦一起响的，它们之间差着几音分，于是互相拍打。
 * 3. 槌子打在弦上的那一下有噪声，很短，但音头是“敲”出来的还是“长”出来的全在它。
 * 4. 衰减分两段：先快后慢。
 *
 * 代价是每个采样要多算好几倍，所以循环拆成了泛音在外、采样点在里 —— 这样衰减可以
 * 一路乘下去，而不是每个采样点重新算一遍 exp。合成一次就进缓存，这笔账只在第一次
 * 点到它的时候付。
 */
function grandPiano(hz: number, decaySec: number, inharmonicity: number, harmonics: number): Synth {
  return ({ sampleRate, seed }) => {
    const data = new Float32Array(frames(sampleRate, decaySec * 2.5))
    const noise = noiseSource(seed)

    // 三根弦各自的音高。先算好放在循环外面：这是个 2 的幂，写在采样点的循环里
    // 要多算上千万次。
    const stringHz = GRAND_STRINGS_CENTS.map((cents) => hz * 2 ** (cents / 1200))

    for (let harmonic = 1; harmonic <= harmonics; harmonic += 1) {
      // 撑开的泛音：频率是 n·f₀·√(1+B·n²) 而不是 n·f₀，次数越高偏得越多。
      const stretch = Math.sqrt(1 + inharmonicity * harmonic * harmonic)
      // 高次泛音散得快，所以音头是亮的、尾巴是圆的 —— 和 `piano` 一样。
      const partialDecaySec = decaySec / harmonic ** 0.7
      const weight = 1 / harmonic ** 1.6
      // 每根弦每个采样点往前走的相位。同样是先算好：这一步里没有常数是变的。
      const stepPerSample = stringHz.map(
        (string) => (2 * Math.PI * string * harmonic * stretch) / sampleRate
      )

      // 衰减往下乘，而不是每个采样点重算 exp：exp 和 sin 一样贵，而这里它只是一
      // 个固定的乘数。乘到末尾的累积误差在 1e-10 量级，听不出来。
      const fastStep = Math.exp(-1 / (sampleRate * (partialDecaySec / PROMPT_RATIO)))
      const slowStep = Math.exp(-1 / (sampleRate * partialDecaySec))
      let fast = 1
      let slow = 1

      for (let index = 0; index < data.length; index += 1) {
        let strings = 0
        for (const step of stepPerSample) {
          strings += Math.sin(step * index)
        }
        // 三根弦取平均而不是相加：一个音不会因为弦多就响三倍。
        const decay = PROMPT_MIX * fast + (1 - PROMPT_MIX) * slow
        data[index] += (strings / stepPerSample.length) * decay * weight
        fast *= fastStep
        slow *= slowStep
      }
    }

    // 槌击噪声单独算一小段再叠上去，而不是跟着泛音堆一起走：它只活在开头十几毫秒
    // 里，混在大循环里就得为它每个采样点判一次条件，而它几乎从不在场。
    const hammer = new Float32Array(frames(sampleRate, HAMMER_SEC))
    for (let index = 0; index < hammer.length; index += 1) {
      const tSec = index / sampleRate
      hammer[index] = noise() * Math.exp(-tSec / (HAMMER_SEC / 5))
    }
    // 削掉两头：太低是“咚”，太高是“嘶”，槌子打在弦上是中间那一点“哒”。
    lowPass(hammer, 4000, sampleRate)
    highPass(hammer, 300, sampleRate)

    for (let index = 0; index < data.length; index += 1) {
      // 音头的斜坡比 `piano` 再长一点：这是槌子，不是拨片。
      const gained = data[index] * attackGain(index / sampleRate, 0.004)
      data[index] = index < hammer.length ? gained + hammer[index] * HAMMER_MIX : gained
    }

    fadeOut(data, sampleRate, 0.03)
    return data
  }
}
