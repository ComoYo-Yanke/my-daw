// .mydaw 工程文件：格式、写出、读回。
//
// 音频本身不进文件 —— 一个工程的采样可能有几十兆，而 .mydaw 要能随手存随手读。
// 通道只记采样是从哪来的（`samplePath`），打开时按路径重新解码，或者按内置采样的
// 伪路径重新合成。代价是移动或删掉采样文件以后工程会缺东西，所以「缺失」是一条
// 正常路径而不是错误：通道照建，只是那一行显示「采样缺失」。
//
// 读回来的东西一律当成不可信。文件是人能改的，改坏了不该让整个工程打不开 —— 所以
// 解析是逐个字段校验加兜底，丢掉不认识的条目，而不是把 JSON 直接断言成工程。
//
// 这个模块不认识 zustand，也不认识 React：它只会在 `DawState` 和一段 JSON 之间翻译。

import { MAX_CURVE_VALUE, MIN_CURVE_VALUE, normalizeCurve, type CurvePoint } from './curve'
import {
  clampDelayParams,
  clampDistortionParams,
  clampReverbParams,
  DEFAULT_DELAY_PARAMS,
  DEFAULT_DISTORTION_PARAMS,
  DEFAULT_REVERB_PARAMS,
  type Effect
} from './effect'
import {
  clampLengthBars,
  DEFAULT_BPM,
  DEFAULT_LENGTH_BARS,
  DEFAULT_VELOCITY,
  MAX_EXTEND_SEC,
  type Note
} from './note'
import {
  DEFAULT_STEP_COUNT,
  emptySteps,
  MAX_STEP_COUNT,
  STEP_COUNT_OPTIONS,
  type StepCount,
  type StepGrid
} from './step'
import {
  makeDefaultTracks,
  MIN_CLIP_LENGTH_BARS,
  MIN_PLAYLIST_BARS,
  type Channel,
  type ChannelType,
  type DawState,
  type Pattern,
  type PlaylistClip,
  type PlaylistTrack,
  type SamplerChannel
} from '../state/useDawStore'
import {
  clampSynthParams,
  DEFAULT_SYNTH_PARAMS,
  FILTER_TYPES,
  OSCILLATOR_COUNTS,
  WAVEFORMS,
  type SynthParams
} from './synth'

/** 文件头的标识。用来认出「这是个 .mydaw」，以及挡住误打开的文件。 */
export const PROJECT_FORMAT = 'mydaw'

/**
 * 格式版本。
 *
 * 读的时候只挡更新的版本：见到未来写的文件就直说，而不是尽力解析出一堆错的东西。
 * 更老的版本留给以后真的需要时再加迁移。
 *
 * 2 起时间线有了轨道和时间线长度。v1 的文件没有这两个字段，不需要单独的迁移分支：
 * 轨道回落成默认的几条、clip 的 trackId 回落到第一条轨、长度回落到最小值，都在下面的
 * 兜底里发生。
 *
 * 之后加字段（比如 clip 可以落在小节中间、播放起点 `songStartBar`、片段自己的音量曲线
 * `volumeCurve`）没有再动版本号：没有哪个字段换了形状，新字段都走逐字段兜底。代价说清楚
 * ——用这一版存出来的文件，被更老的版本打开时，片段会被四舍五入回整小节、播放起点和曲线
 * 会被丢掉，属于「能打开但缺东西」，而不是打不开。
 *
 * 删字段同样没动版本号。`playMode`（Pattern / Song 那个开关）不存在了：空格播什么由
 * 鼠标所在的窗口决定，没有东西可切换。老文件里多出来的这个字段读的时候被忽略，所以
 * 老工程照常打开；反过来的代价和上面一样——老版本打开新文件时会回落成 `'pattern'`。
 *
 * 通道长出 `type` 和 `synth` 也没动版本号：没有 `type` 的文件里每一条通道都是采样器，
 * 而这正是读不到 `type` 时的兜底，所以 v1/v2 的工程打开后一模一样。
 *
 * 通道再长出 `effects` 同样没动版本号。老文件里没有这个字段，回落到空链 —— 那正是老工程
 * 本来的样子：它没有效果器。反过来的代价还是上面那一条——更老的版本打开这一版存的文件时，
 * 效果链会被整条丢掉，也是「能打开但缺东西」。
 */
export const PROJECT_VERSION = 2

/**
 * 拍号。
 *
 * 目前是占位的：写进文件、读回来，但不参与任何计算 —— 网格和播放的 BEATS_PER_BAR
 * 还是 4。留着字段是为了以后真做拍号时，老工程不用改格式就能读。
 */
export const DEFAULT_TIME_SIGNATURE = '4/4'

/**
 * 一个通道在文件里的样子。
 *
 * 和内存里的 `Channel` 有三处不一样。它记采样从哪来（`samplePath`），而不是记一个只在
 * 这次运行里有效的 `sampleId`。它带着 `type`，因为文件里的通道不再都是采样器了。而
 * `synth` 只在合成器通道上有：采样器没有参数可写，给每一条鼓都存一份用不上的参数，
 * 等于在文件里说一件不成立的事。
 *
 * 并列写而不是从 `Channel` 推导，是因为它要同时容下两种通道 —— 从联合类型 `Omit` 出来的
 * 东西会把两条分支揉在一起，反而看不出哪条该带什么。
 */
export type ProjectChannel = {
  id: string
  name: string
  type: ChannelType
  /** 磁盘上的绝对路径，或者 `library://` 开头的内置采样伪路径。合成器通道是空串。 */
  samplePath: string
  /** 合成器通道才有 —— 见上面。 */
  synth?: SynthParams
  /**
   * 这个通道的效果链，按链上的顺序。
   *
   * 两种通道都有 —— 采样器和合成器一样要混响，所以它不像 `synth` 那样是可选字段。老文件
   * 里没有这一项，回落到空链。
   */
  effects: Effect[]
  volume: number
  pan: number
  muted: boolean
  soloed: boolean
  color: string
  stepCount: StepCount
  swing: number
}

export type ProjectFile = {
  format: string
  version: number
  bpm: number
  timeSignature: string
  currentPatternId: string
  channels: ProjectChannel[]
  patterns: Pattern[]
  /** 时间线的轨道。裁剪、静音、独奏都挂在这里，所以要存。 */
  playlistTracks: PlaylistTrack[]
  /** 时间线显示多少小节。只增不减，所以存的是用户铺开的那一段。 */
  playlistBars: number
  playlistClips: PlaylistClip[]
  /**
   * 整首歌从哪里开始播，单位小节。
   *
   * 和 clip 的位置一样按小节存，不按秒：改速度时播放线要跟着音乐走，而不是滑到
   * 别的小节上。v2 文件没有这个字段，回落到 0。
   */
  songStartBar: number
}

// 兜底值
//
// 只在文件缺字段或字段坏了的时候才用得上，所以它们要挡住的是「解析不出来」，而不是
// 定义工程该长什么样。数值刻意和 store 里新建通道的默认值对齐，免得一份坏文件打开
// 后冒出一堆音量为 1 的通道。

const FALLBACK_VOLUME = 0.8
const FALLBACK_PAN = 0
const FALLBACK_COLOR = '#6c8cff'
const FALLBACK_PATTERN_NAME = 'Pattern'
const FALLBACK_CHANNEL_NAME = 'Channel'
const FALLBACK_TRACK_NAME = 'Track'

/**
 * 一个通道的采样从哪来。
 *
 * 找不到文件的采样在 `missingSamplePaths` 里留着自己的原路径，所以「打开一份采样丢了
 * 的工程、再存回去」不会把路径抹掉 —— 用户把文件放回去以后还能对上。
 */
function samplePathOf(state: DawState, channel: SamplerChannel): string {
  const sample = state.samples.find((item) => item.id === channel.sampleId)
  return sample?.path ?? state.missingSamplePaths[channel.sampleId] ?? ''
}

/** 两种通道共有的那部分字段，原样搬过去。 */
function channelBaseOf(channel: Channel): Omit<ProjectChannel, 'type' | 'samplePath' | 'synth'> {
  return {
    id: channel.id,
    name: channel.name,
    // 原样搬过去。效果器本身是纯数据，没有 id 之外的东西指向这次运行里的任何对象。
    effects: channel.effects,
    volume: channel.volume,
    pan: channel.pan,
    muted: channel.muted,
    soloed: channel.soloed,
    color: channel.color,
    stepCount: channel.stepCount,
    swing: channel.swing
  }
}

/**
 * 一个通道写进文件的样子。
 *
 * 采样器那条留一个空的 `samplePath` 是有意义的：路径丢了但要保住「它是个采样器」这件事，
 * 通道才会以「采样缺失」的样子回来，而不是变成一个合成器。
 */
function serializeChannel(state: DawState, channel: Channel): ProjectChannel {
  if (channel.type === 'synth') {
    return { ...channelBaseOf(channel), type: 'synth', samplePath: '', synth: channel.synth }
  }
  return { ...channelBaseOf(channel), type: 'sampler', samplePath: samplePathOf(state, channel) }
}

/** 把当前工程写成文件内容。 */
export function serializeProject(state: DawState): ProjectFile {
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    bpm: state.bpm,
    timeSignature: DEFAULT_TIME_SIGNATURE,
    currentPatternId: state.currentPatternId,
    channels: state.channels.map((channel) => serializeChannel(state, channel)),
    // 音符和步进是纯数据，跟着 pattern 原样走。
    patterns: state.patterns,
    playlistTracks: state.playlistTracks,
    // 存的是用户铺开的那一段，不是「现画的这一屏」——读回来时时间线不会缩回去。
    playlistBars: state.playlistBars,
    playlistClips: state.playlistClips,
    // 播放起点存下来，但 `playlistSnapEnabled` / `playlistSnapDivision` 不存：
    // 和钢琴卷帘的吸附设置一样，它们说的是「接下来怎么拖」，不是工程长什么样。
    songStartBar: state.songStartBar
  }
}

export type ParseResult = { ok: true; project: ProjectFile } | { ok: false; error: string }

/**
 * 把文件内容读成一份工程。
 *
 * 读得动就尽量读：一个字段坏了就退回兜底值，一条记录坏了就丢掉它，只有整个文件不成
 * 形状（不是 JSON、不是 .mydaw、版本太新、一个 pattern 都没有）才拒绝打开。
 */
export function parseProjectFile(text: string): ParseResult {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, error: '文件不是合法的 JSON' }
  }

  if (!isRecord(raw)) return { ok: false, error: '工程文件的内容不是一个对象' }
  if (raw.format !== PROJECT_FORMAT) return { ok: false, error: '这不是一个 .mydaw 工程文件' }

  const version = num(raw.version, 0)
  if (version > PROJECT_VERSION) {
    return {
      ok: false,
      error: `工程文件的版本是 ${version}，比当前支持的 ${PROJECT_VERSION} 新`
    }
  }

  const patterns = parsePatterns(raw.patterns)
  // 一个工程至少要有一个 pattern 可以编辑，就像新建时那样。
  if (patterns.length === 0) return { ok: false, error: '工程里没有 Pattern' }

  const channels = parseChannels(raw.channels)
  // 当前 pattern 有可能指向一个已经被删掉的 id，落到第一个上比留一个悬空的 id 好。
  const wantedPatternId = str(raw.currentPatternId, '')
  const currentPattern = patterns.find((pattern) => pattern.id === wantedPatternId) ?? patterns[0]

  // 轨道先读：clip 的 trackId 要拿它来校验，文件里没有的轨道只能落到第一条上。
  const tracks = parseTracks(raw.playlistTracks)

  return {
    ok: true,
    project: {
      format: PROJECT_FORMAT,
      version,
      bpm: num(raw.bpm, DEFAULT_BPM),
      timeSignature: str(raw.timeSignature, DEFAULT_TIME_SIGNATURE),
      currentPatternId: currentPattern.id,
      channels,
      patterns,
      playlistTracks: tracks,
      // 只挡住变短：时间线是只能长不能短的东西，比最小值还小的长度没有意义。
      playlistBars: Math.max(
        MIN_PLAYLIST_BARS,
        Math.round(num(raw.playlistBars, MIN_PLAYLIST_BARS))
      ),
      playlistClips: parseClips(raw.playlistClips, tracks),
      // 负的开始位置没有意义；上界不在这里挡，时间线的长度随时会变，读的时候
      // 会再夹一次（`selectSongStartBar`）。
      songStartBar: Math.max(0, num(raw.songStartBar, 0))
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/** A fresh id for an entry the file left without one. */
function id(value: unknown): string {
  return str(value, crypto.randomUUID())
}

/**
 * 文件里的通道。
 *
 * 没有 `type` 的文件是合成器出现之前存的，里面每一条都是采样器 —— 这不是特例分支，正是
 * 「认不出 type 就当采样器」这条兜底的默认结果。
 */
function parseChannels(value: unknown): ProjectChannel[] {
  if (!Array.isArray(value)) return []

  const channels: ProjectChannel[] = []
  for (const entry of value) {
    if (!isRecord(entry)) continue

    const base = {
      id: id(entry.id),
      name: str(entry.name, FALLBACK_CHANNEL_NAME),
      // 没有这个字段的老文件回落到空链，也就是「没有效果器」——老工程本来的样子。
      effects: parseEffects(entry.effects),
      volume: clamp(num(entry.volume, FALLBACK_VOLUME), 0, 1),
      pan: clamp(num(entry.pan, FALLBACK_PAN), -1, 1),
      muted: bool(entry.muted, false),
      soloed: bool(entry.soloed, false),
      color: str(entry.color, FALLBACK_COLOR),
      stepCount: parseStepCount(entry.stepCount),
      swing: clamp(num(entry.swing, 0), 0, 100)
    }

    if (entry.type === 'synth') {
      channels.push({
        ...base,
        type: 'synth',
        samplePath: '',
        // 少了这一整块就退回默认参数：一个还没调过的合成器，仍然是一个能弹的合成器。
        synth: parseSynth(entry.synth)
      })
      continue
    }

    channels.push({ ...base, type: 'sampler', samplePath: str(entry.samplePath, '') })
  }
  return channels
}

/**
 * 一组合成器参数。
 *
 * 逐字段兜底：缺一个就补一个默认值。一组被手改坏的参数应该少一个数，而不是让整个通道
 * 变成别的东西 —— 和工程里其它地方一样，能读的尽量读。
 *
 * 认不出的波形、滤波器、振荡器个数一律回到默认值，而不是硬塞进列表里：它们不是数值，
 * 没有「就近」这一说。夹取交给 `clampSynthParams`，和面板写进来的走同一条路，于是无论
 * 从哪边进来，音频那边拿到的都是一样合法的数。
 */
function parseSynth(value: unknown): SynthParams {
  if (!isRecord(value)) return DEFAULT_SYNTH_PARAMS

  return clampSynthParams({
    waveform: WAVEFORMS.find((item) => item === value.waveform) ?? DEFAULT_SYNTH_PARAMS.waveform,
    oscCount:
      OSCILLATOR_COUNTS.find((item) => item === value.oscCount) ?? DEFAULT_SYNTH_PARAMS.oscCount,
    detuneCents: num(value.detuneCents, DEFAULT_SYNTH_PARAMS.detuneCents),
    attackSec: num(value.attackSec, DEFAULT_SYNTH_PARAMS.attackSec),
    decaySec: num(value.decaySec, DEFAULT_SYNTH_PARAMS.decaySec),
    sustain: num(value.sustain, DEFAULT_SYNTH_PARAMS.sustain),
    releaseSec: num(value.releaseSec, DEFAULT_SYNTH_PARAMS.releaseSec),
    filterType:
      FILTER_TYPES.find((item) => item === value.filterType) ?? DEFAULT_SYNTH_PARAMS.filterType,
    cutoffHz: num(value.cutoffHz, DEFAULT_SYNTH_PARAMS.cutoffHz),
    q: num(value.q, DEFAULT_SYNTH_PARAMS.q)
  })
}

/**
 * 一条效果链。
 *
 * 数组的顺序就是链上的顺序，原样保留：链是有序的，先失真再延迟和先延迟再失真是两个声音，
 * 所以这里不做任何整理。
 *
 * 认不出 `type` 的那一格整条丢掉，和认不出的波形同一个原则 —— 它不是数值，没有「就近」
 * 可言，而一个不知道该做成什么的效果器留在链上只会挡住它后面的。
 */
function parseEffects(value: unknown): Effect[] {
  if (!Array.isArray(value)) return []

  const effects: Effect[] = []
  for (const entry of value) {
    if (!isRecord(entry)) continue
    const effect = parseEffect(entry)
    if (effect !== null) effects.push(effect)
  }
  return effects
}

/**
 * 一格效果器。认不出 `type` 就是 `null`，由上面丢掉。
 *
 * 每条分支和 `parseSynth` 是同一套做法：逐字段兜底，缺一个就补一个默认值，最后交给对应的
 * `clampXxxParams` 夹取 —— 和面板写进来的走同一条路，于是无论从哪边进来，音频那边拿到的
 * 都是一样合法的数。
 *
 * 这里没有走 `withEffectParams`，因为它是「把参数放回已经存在的那一格上」，而这里的问题
 * 是「照着文件搭出那一格」。夹取用的是同一组函数，所以出口是一样的。
 */
function parseEffect(entry: Record<string, unknown>): Effect | null {
  const effectId = id(entry.id)
  const enabled = bool(entry.enabled, true)
  const params = isRecord(entry.params) ? entry.params : {}

  switch (str(entry.type, '')) {
    case 'reverb':
      return {
        id: effectId,
        type: 'reverb',
        enabled,
        params: clampReverbParams({
          roomSize: num(params.roomSize, DEFAULT_REVERB_PARAMS.roomSize),
          damping: num(params.damping, DEFAULT_REVERB_PARAMS.damping),
          wet: num(params.wet, DEFAULT_REVERB_PARAMS.wet)
        })
      }
    case 'delay':
      return {
        id: effectId,
        type: 'delay',
        enabled,
        params: clampDelayParams({
          timeSec: num(params.timeSec, DEFAULT_DELAY_PARAMS.timeSec),
          feedback: num(params.feedback, DEFAULT_DELAY_PARAMS.feedback),
          wet: num(params.wet, DEFAULT_DELAY_PARAMS.wet)
        })
      }
    case 'distortion':
      return {
        id: effectId,
        type: 'distortion',
        enabled,
        params: clampDistortionParams({
          drive: num(params.drive, DEFAULT_DISTORTION_PARAMS.drive),
          toneHz: num(params.toneHz, DEFAULT_DISTORTION_PARAMS.toneHz),
          outputGain: num(params.outputGain, DEFAULT_DISTORTION_PARAMS.outputGain)
        })
      }
    default:
      return null
  }
}

/** A step count that is not one of the four the switch offers falls back to the default. */
function parseStepCount(value: unknown): StepCount {
  const count = num(value, 0)
  return STEP_COUNT_OPTIONS.find((option) => option === count) ?? DEFAULT_STEP_COUNT
}

function parsePatterns(value: unknown): Pattern[] {
  if (!Array.isArray(value)) return []

  const patterns: Pattern[] = []
  for (const entry of value) {
    if (!isRecord(entry)) continue
    patterns.push({
      id: id(entry.id),
      name: str(entry.name, FALLBACK_PATTERN_NAME),
      lengthBars: clampLengthBars(num(entry.lengthBars, DEFAULT_LENGTH_BARS)),
      notesByChannel: parseNotesByChannel(entry.notesByChannel),
      stepsByChannel: parseStepsByChannel(entry.stepsByChannel)
    })
  }
  return patterns
}

function parseNotesByChannel(value: unknown): Record<string, Note[]> {
  if (!isRecord(value)) return {}

  const byChannel: Record<string, Note[]> = {}
  for (const [channelId, notes] of Object.entries(value)) {
    if (!Array.isArray(notes)) continue
    byChannel[channelId] = notes.filter(isRecord).map((note) => ({
      id: id(note.id),
      // 负的开始时间或长度没有意义，而播放调度是按它们算的。
      startSec: Math.max(0, num(note.startSec, 0)),
      lengthSec: Math.max(0, num(note.lengthSec, 0)),
      // 没有这个字段的工程是延长量出现之前存的，读回来就是 0 —— 也正是「不延长」。
      extend: clamp(num(note.extend, 0), 0, MAX_EXTEND_SEC),
      pitch: num(note.pitch, 0),
      velocity: clamp(num(note.velocity, DEFAULT_VELOCITY), 0, 127)
    }))
  }
  return byChannel
}

/**
 * Step grids come back at their stored length, whatever the file said.
 *
 * A grid is always `MAX_STEP_COUNT` long so a channel can shrink to 4 steps and grow
 * back without having lost the rest (see `StepGrid`), and every reader assumes that.
 */
function parseStepsByChannel(value: unknown): Record<string, StepGrid> {
  if (!isRecord(value)) return {}

  const byChannel: Record<string, StepGrid> = {}
  for (const [channelId, grid] of Object.entries(value)) {
    if (!Array.isArray(grid)) continue
    const steps = emptySteps()
    for (let index = 0; index < Math.min(grid.length, MAX_STEP_COUNT); index += 1) {
      steps[index] = grid[index] === true
    }
    byChannel[channelId] = steps
  }
  return byChannel
}

/**
 * 时间线的轨道。
 *
 * 没有这个字段（v1 文件），或者里面一条都没读出来，都回落成默认那几条：一个放不下 clip
 * 的时间线不算时间线，而默认轨道和新建工程时给的是同一批（`makeDefaultTracks`），所以
 * 「打开老工程」和「新建工程」看起来一样。
 */
function parseTracks(value: unknown): PlaylistTrack[] {
  if (!Array.isArray(value)) return makeDefaultTracks()

  const tracks: PlaylistTrack[] = []
  for (const entry of value) {
    if (!isRecord(entry)) continue
    tracks.push({
      id: id(entry.id),
      name: str(entry.name, FALLBACK_TRACK_NAME),
      muted: bool(entry.muted, false),
      soloed: bool(entry.soloed, false)
    })
  }
  return tracks.length > 0 ? tracks : makeDefaultTracks()
}

/**
 * 时间线上的 clip。
 *
 * `lengthBars` 是 clip 自己的长度，和里面的 pattern 多长无关，所以这里只挡住「短过一个拍」
 * ——那是唯一没有意义的长度。位置和长度都**不取整**：关掉吸附以后片段本来就落在小节中间，
 * 取整会把用户摆好的东西挪走。v1 文件没有 `trackId`，文件也可能写了一条已经不在的轨道，
 * 两种都落到第一条轨上，也就是它们本来在的地方。
 *
 * `volumeCurve` 没有的文件读回来是一个空数组，也就是「没有自动化」——那时候显示和播放都
 * 按节拍里的音符力度现算一条默认曲线，所以少这个字段的老工程看起来和新的一样。
 */
function parseClips(value: unknown, tracks: PlaylistTrack[]): PlaylistClip[] {
  if (!Array.isArray(value)) return []

  const fallbackTrackId = tracks[0].id
  const clips: PlaylistClip[] = []
  for (const entry of value) {
    if (!isRecord(entry)) continue
    const patternId = str(entry.patternId, '')
    // A clip pointing at no pattern could never be played or resized.
    if (patternId === '') continue
    const trackId = str(entry.trackId, '')
    clips.push({
      id: id(entry.id),
      patternId,
      trackId: tracks.some((track) => track.id === trackId) ? trackId : fallbackTrackId,
      startBar: Math.max(0, num(entry.startBar, 0)),
      lengthBars: Math.max(MIN_CLIP_LENGTH_BARS, num(entry.lengthBars, 1)),
      volumeCurve: parseCurve(entry.volumeCurve)
    })
  }
  return clips
}

/**
 * 一段片段的音量曲线。
 *
 * 读得动几个点是几个点：一条曲线少一个节点还是一条能播的曲线，而整个片段因为一个坏的
 * 节点就没了音量才是真的丢东西。时间统一夹到不小于 0，值夹进 0..1——曲线的两个轴都是有
 * 界的，界外的东西画不出来也播不出来。
 *
 * `normalizeCurve` 顺手把顺序理好：曲线的点必须按时间升序，播放那边是按顺序写增益的。
 */
function parseCurve(value: unknown): CurvePoint[] {
  if (!Array.isArray(value)) return []

  const points: CurvePoint[] = []
  for (const entry of value) {
    if (!isRecord(entry)) continue
    points.push({
      time: Math.max(0, num(entry.time, 0)),
      value: clamp(num(entry.value, MAX_CURVE_VALUE), MIN_CURVE_VALUE, MAX_CURVE_VALUE)
    })
  }
  return normalizeCurve(points)
}
