// 音量曲线：一个片段自己的音量随时间的走向。
//
// 这是全工程唯一一处「音量」不是一个数而是一条折线的地方，所以单位在这里定死，
// 别处不再重复：`time` 是从片段起点算起的秒，`value` 是 0..1 的线性增益。用秒是
// 为了和音符、和音频时钟用同一把尺子（见 CLAUDE.md 的时间单位约定）；换速度时它
// 和音符按同一个比例缩放，所以缩完之后曲线仍然横跨同一个片段。
//
// 点之间是直线，取值就是这条直线上的值。一个点都没有是「没有自动化」——那时候
// 播放按原音量走，那是调用方的事；这里只负责算出折线本身。
//
// 这个模块不认识 zustand，也不认识 React，也不认识片段：它只认识一条折线。

import { MAX_VELOCITY, type Note } from './note'

/** 曲线上的一个节点。 */
export type CurvePoint = {
  /** 从片段起点算起的秒。不小于 0。 */
  time: number
  /** 线性增益，0..1。 */
  value: number
}

export const MIN_CURVE_VALUE = 0
export const MAX_CURVE_VALUE = 1

/**
 * 两个节点之间最近能挨多近，秒。
 *
 * 一毫秒：比这个工程里任何能画出来的网格都细（最快速度下一个 1/64 也有三十毫秒），
 * 所以它挡不住任何认真的编辑，只挡住「两个点落在同一瞬间」这一种没有意义的结果。
 */
export const MIN_CURVE_GAP_SEC = 0.001

/**
 * 一条空曲线。
 *
 * 共享同一个数组，让「这个片段没有自动化」在两次渲染之间是同一个引用 —— 读它的
 * 地方（`useMemo` 的依赖、React 的 props）才不会被一个每次新建的空数组推着重算。
 */
export const NO_CURVE: CurvePoint[] = []

export function clampCurveValue(value: number): number {
  return Math.min(Math.max(value, MIN_CURVE_VALUE), MAX_CURVE_VALUE)
}

/**
 * 一条能直接画、直接播的曲线：按时间排好、值夹进 0..1、时间不小于 0。
 *
 * 同一时刻只留一个节点。文件是人能改的，两个节点落在同一个瞬间没有意义，而排在
 * 后面那个会把前面那个变成一次零长度的跳变；留下来的是先到的那个。
 */
export function normalizeCurve(points: CurvePoint[]): CurvePoint[] {
  const sorted = points
    .map((point) => ({
      time: Math.max(0, point.time),
      value: clampCurveValue(point.value)
    }))
    .sort((a, b) => a.time - b.time)

  const out: CurvePoint[] = []
  for (const point of sorted) {
    const last = out[out.length - 1]
    if (last !== undefined && point.time <= last.time) continue
    out.push(point)
  }
  return out
}

/**
 * 曲线在某一时刻的值。
 *
 * 第一个节点之前保持第一个节点的值，最后一个节点之后保持最后一个节点的值：一条
 * 折线的两头之外是它自己的水平延长线，而不是零。所以一个音符从曲线中段起音时，
 * 它起音的音量就是曲线在那里的值，而不是从头再来一遍。
 *
 * 空曲线返回 1 —— 原音量。调用方本来就不该拿空曲线来问，这里是兜底而不是语义。
 */
export function curveValueAt(points: CurvePoint[], time: number): number {
  const first = points[0]
  if (first === undefined) return MAX_CURVE_VALUE
  if (time <= first.time) return first.value

  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]
    const current = points[index]
    if (time > current.time) continue
    const span = current.time - previous.time
    // 两个节点时间相同是排不出来的（`normalizeCurve` 挡掉了），但这里不假设它。
    if (span <= 0) return current.value
    return previous.value + ((time - previous.time) / span) * (current.value - previous.value)
  }

  const last = points[points.length - 1]
  return last.value
}

/**
 * 从一个 Pattern 的音符力度读出的一条曲线。
 *
 * 这是「默认曲线」：片段自己没存过曲线时，显示用的是这一条。它不写进工程，
 * 所以打开曲线显示这个纯看的行为既不会弄脏工程，也不会占一个撤销步骤，而改一次
 * 音符力度也就自动改了默认曲线。
 *
 * **只给显示用，不能拿去播放。** 这条线是力度的图像，而力度本来就是发声的那一份：
 * 每个音符自己的力度已经被调度器写成一个增益，播放再乘上这条曲线就是把它算了
 * 两遍（`selectSongTimeline` 以前就是这么做的，力度 100 的音符出来是 (100/127)²）。
 * 决定声音的地方要读片段存下来的 `volumeCurve`，没有就是没有自动化。
 *
 * 每个音符的起音处一个节点，值就是它的力度；片段比 Pattern 长时，循环的每一遍
 * 都按自己的位置再铺一次。和弦（同一时刻几个音符）取最响的那个——包络由最响的
 * 那个决定。
 *
 * 首尾各补一个节点，保持端点值：曲线要横跨片段的整个长度，而不是从第一个音符
 * 开始、到最后一个音符就断掉。
 *
 * `barSec` 必须是这些音符钉住的那个速度下的一小节秒数（音符存的是秒），不是渲染
 * 时想用的速度——调用方如果要换速度渲染，会和音符一起按同一个比例再缩放一遍。
 */
export function curveFromNotes(
  notes: Note[],
  patternBars: number,
  clipBars: number,
  barSec: number
): CurvePoint[] {
  const patternSec = patternBars * barSec
  const clipSec = clipBars * barSec
  if (notes.length === 0 || patternSec <= 0 || clipSec <= 0) return NO_CURVE

  // 和片段播放次数同一套算法，连那个 epsilon 都是同一个理由：`clipBars / patternBars`
  // 对某些长度会算出 2.0000000000000004，多出来的那一遍是空的一遍。
  const plays = Math.max(1, Math.ceil(clipBars / patternBars - 1e-9))

  /** 时刻 -> 该时刻最响的力度。键是浮点数，但同一格上的音符秒数是同一个浮点数。 */
  const loudest = new Map<number, number>()
  for (let play = 0; play < plays; play += 1) {
    const offsetSec = play * patternSec
    if (offsetSec >= clipSec) break

    for (const note of notes) {
      const time = offsetSec + note.startSec
      // 起音落在片段之外的音符根本不会被播放，也就不该在曲线上留下一个节点。
      if (time >= clipSec) continue
      const value = clampCurveValue(note.velocity / MAX_VELOCITY)
      const held = loudest.get(time)
      if (held === undefined || value > held) loudest.set(time, value)
    }
  }
  if (loudest.size === 0) return NO_CURVE

  const points = [...loudest.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([time, value]) => ({ time, value }))

  return normalizeCurve([
    { time: 0, value: points[0].value },
    ...points,
    { time: clipSec, value: points[points.length - 1].value }
  ])
}

/**
 * 拖动一个节点之后整条曲线的样子。
 *
 * 被拖的节点留在它两个邻居之间：时间上不过界。这样拖动中它的序号一直有效，不必
 * 处理「两个节点交换了位置」和「两个节点撞在同一时刻」这两件事，而曲线是一条随
 * 时间走的折线，节点的先后本来就是它的一部分。
 *
 * 值不设这个限，只有 0..1 本身。`maxTimeSec` 是片段有多长，最后一个节点也走不出
 * 片段之外——走出去了它就在画不出来的地方，够也够不着。
 */
export function withMovedPoint(
  points: CurvePoint[],
  index: number,
  time: number,
  value: number,
  maxTimeSec: number
): CurvePoint[] {
  const point = points[index]
  if (point === undefined) return points

  const low = index > 0 ? points[index - 1].time + MIN_CURVE_GAP_SEC : 0
  const high = index < points.length - 1 ? points[index + 1].time - MIN_CURVE_GAP_SEC : maxTimeSec

  const next = [...points]
  next[index] = {
    // 邻居挨得比两个最小间隔还近时（文件里读回来的）`low` 会大于 `high`，那就停在
    // `low` 上：这个节点不动，而不是跳到邻居另一边去。
    time: Math.min(Math.max(time, low), Math.max(low, high)),
    value: clampCurveValue(value)
  }
  return next
}
