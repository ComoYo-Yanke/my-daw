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

import {
  clampLengthBars,
  DEFAULT_BPM,
  DEFAULT_LENGTH_BARS,
  DEFAULT_VELOCITY,
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
  type DawState,
  type Pattern,
  type PlaylistClip,
  type PlaylistTrack
} from '../state/useDawStore'

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
 * 之后加字段（比如 clip 可以落在小节中间、播放起点 `songStartBar`）没有再动版本号：
 * 没有哪个字段换了形状，新字段都走逐字段兜底。代价说清楚——用这一版存出来的文件，被
 * 更老的版本打开时，片段会被四舍五入回整小节、播放起点会被丢掉，属于「能打开但缺东西」，
 * 而不是打不开。
 *
 * 删字段同样没动版本号。`playMode`（Pattern / Song 那个开关）不存在了：空格播什么由
 * 鼠标所在的窗口决定，没有东西可切换。老文件里多出来的这个字段读的时候被忽略，所以
 * 老工程照常打开；反过来的代价和上面一样——老版本打开新文件时会回落成 `'pattern'`。
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
 * 和内存里的 `Channel` 只差一处：它记采样从哪来，而不是记一个只在这次运行里有效的
 * `sampleId`。
 */
export type ProjectChannel = Omit<Channel, 'sampleId'> & {
  /** 磁盘上的绝对路径，或者 `library://` 开头的内置采样伪路径。 */
  samplePath: string
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
function samplePathOf(state: DawState, channel: Channel): string {
  const sample = state.samples.find((item) => item.id === channel.sampleId)
  return sample?.path ?? state.missingSamplePaths[channel.sampleId] ?? ''
}

/** 把当前工程写成文件内容。 */
export function serializeProject(state: DawState): ProjectFile {
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    bpm: state.bpm,
    timeSignature: DEFAULT_TIME_SIGNATURE,
    currentPatternId: state.currentPatternId,
    channels: state.channels.map((channel) => ({
      id: channel.id,
      name: channel.name,
      samplePath: samplePathOf(state, channel),
      volume: channel.volume,
      pan: channel.pan,
      muted: channel.muted,
      soloed: channel.soloed,
      color: channel.color,
      stepCount: channel.stepCount,
      swing: channel.swing
    })),
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

function parseChannels(value: unknown): ProjectChannel[] {
  if (!Array.isArray(value)) return []

  const channels: ProjectChannel[] = []
  for (const entry of value) {
    if (!isRecord(entry)) continue
    channels.push({
      id: id(entry.id),
      name: str(entry.name, FALLBACK_CHANNEL_NAME),
      samplePath: str(entry.samplePath, ''),
      volume: clamp(num(entry.volume, FALLBACK_VOLUME), 0, 1),
      pan: clamp(num(entry.pan, FALLBACK_PAN), -1, 1),
      muted: bool(entry.muted, false),
      soloed: bool(entry.soloed, false),
      color: str(entry.color, FALLBACK_COLOR),
      stepCount: parseStepCount(entry.stepCount),
      swing: clamp(num(entry.swing, 0), 0, 100)
    })
  }
  return channels
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
      lengthBars: Math.max(MIN_CLIP_LENGTH_BARS, num(entry.lengthBars, 1))
    })
  }
  return clips
}
