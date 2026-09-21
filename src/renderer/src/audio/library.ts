// 内置采样库：一台不需要任何文件的鼓机兼音源。
//
// 采样不是磁盘上的 WAV，而是几个合成函数的输出。理由很直接：仓库里不放二进制，
// 工程文件也不用背着一堆音频 —— 一个内置采样的身份就是它的伪路径
// （`library://drums/kick/808`）。打开工程时按同一个函数重新合成，听到的还是同一个
// 声音。
//
// 所以每个合成函数都必须是确定性的：噪声用固定种子的伪随机，而不是 Math.random，
// 否则同一个工程每打开一次，鼓的音色都会变一点。
//
// 合成在首次用到时做一次，结果缓存在这里。AudioBuffer 是不可变的，所以一个采样被
// 多个通道共享是安全的 —— 和导入的采样走的是同一套。

import { getAudioContext } from './engine'

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

/** 一个内置采样。 */
export type LibrarySample = {
  /** 伪路径，也是工程文件里存的东西。 */
  path: string
  name: string
  /**
   * 峰值电平，0..1。
   *
   * 库内部的一个粗混音：不这么做的话每个采样都会被归一化到同一个峰值，踩镲会和
   * 底鼓一样响。通道自己的音量仍然可以再拧。
   */
  level: number
  synth: Synth
}

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

/** 合成好的缓冲，按路径缓存。 */
const rendered = new Map<string, AudioBuffer>()

/** 这个路径是不是一个内置采样。 */
export function isLibraryPath(path: string): boolean {
  return path.startsWith(LIBRARY_SCHEME)
}

/**
 * 取一个内置采样的 AudioBuffer，第一次用到时合成。
 *
 * 缓存不是优化而是必须的：一个采样可能被好几个通道用着，而每次点击都重新合成一段
 * 几秒钟的 PCM 会明显卡一下。
 *
 * 路径不在库里时返回 null —— 打开一份工程时这是「这个采样丢了」，不是崩溃的理由。
 */
export function renderLibrarySample(
  path: string
): { sample: LibrarySample; buffer: AudioBuffer } | null {
  const sample = BY_PATH.get(path)
  if (sample === undefined) return null

  const cached = rendered.get(path)
  if (cached !== undefined) return { sample, buffer: cached }

  const context = getAudioContext()
  const data = sample.synth({ sampleRate: context.sampleRate, seed: pathSeed(path) })
  normalize(data, sample.level)

  const buffer = context.createBuffer(1, data.length, context.sampleRate)
  // `set` rather than `copyToChannel`: the two do the same thing, and this one
  // does not care which kind of backing buffer the array came out of.
  buffer.getChannelData(0).set(data)
  rendered.set(path, buffer)
  return { sample, buffer }
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
