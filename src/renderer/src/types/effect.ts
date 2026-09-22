// 通道效果链上的效果器：类型、参数、边界和夹取。
//
// 一条效果链是通道的一部分，和音量、声像、步进一样 —— 它说的是「这个通道的声音长什么样」，
// 和用哪个 Pattern 放它没有关系。链是**有序**的：先失真再延迟和先延迟再失真不是同一件事，
// 所以这里的列表是有序列表，不是集合。
//
// 三种效果器的参数没有任何一个字段是共有的，所以 `Effect` 是可辨识联合，而不是「一个 params
// 里放着所有字段、用不到的留着」：混响上没有 drive 这种东西，把它写成能写出来的样子就是错的。
// 代价是所有读参数的地方都要先按 `type` 收窄；好处正是收窄之后，每个分支拿到的都是它自己那份
// 具体类型，「哪个旋钮在改哪个数」是全静态的，不需要断言，也不会写错字段名。
//
// 单位一律是秒和赫兹，和工程里别的地方一样。这些数字最终会直接写进 AudioParam 或者用来算一条
// 曲线，中间不再换算。0..1 的比例就是 0..1，不写成百分比 —— 百分比是面板显示的事。
//
// 这个模块不碰 Web Audio，也不认识通道：它只有数字、边界和夹取。真正把数字变成声音的是
// `audio/effects.ts`。

/** 混响：给声音加一个房间。 */
export type ReverbParams = {
  /** 房间大小 0..1。决定脉冲响应有多长，也就是尾巴有多长。 */
  roomSize: number
  /** 阻尼 0..1。尾巴里的高频衰减得多快，越大越暗。 */
  damping: number
  /** 湿声占多少，0..1。干声是 1 减去它，所以这是一个真正的混合比。 */
  wet: number
}

/** 延迟：把声音按固定间隔重复。 */
export type DelayParams = {
  /** 两次重复之间隔多久，秒。 */
  timeSec: number
  /** 每次重复送回输入的量，0..`MAX_FEEDBACK`。 */
  feedback: number
  /** 同混响：湿声占多少，干了就是 1 减去它。 */
  wet: number
}

/** 失真：把波形削平，长出谐波。 */
export type DistortionParams = {
  /**
   * 驱动量 0..1。
   *
   * 0 是恒等映射 —— 加一个驱动为 0 的失真和没加听起来一模一样，A/B 才做得起来。往上是把
   * 波形削得越来越平，而它的副作用是**把小信号抬起来**（这正是失真本身，不是 bug），所以
   * 旁边那根输出增益不是摆设。
   */
  drive: number
  /** 音调：失真之后那个低通的截止频率，赫兹。削完留多少高频由它说了算。 */
  toneHz: number
  /** 输出增益 0..1。1 是原样，往下是把驱动推上去的响度拉回来。 */
  outputGain: number
}

export type EffectParams = ReverbParams | DelayParams | DistortionParams

export type EffectType = 'reverb' | 'delay' | 'distortion'

/**
 * 效果链上的一格。
 *
 * `enabled` 是旁通而不是删除：关掉的效果器留在链上原来的位置，参数也留着，再打开就是原来的
 * 声音。这和「删掉再加一个」不是同一件事 —— 后者是一次重来，前者是把手放在开关上。
 *
 * `id` 用来在链上认出它自己：移动、删除、改参数都是按 id 找到那一格。它和效果器**是什么**是
 * 两回事，同一格可以从混响换成延迟，只要 id 还在，链上的位置就还是它的。
 */
export type Effect =
  | { id: string; type: 'reverb'; enabled: boolean; params: ReverbParams }
  | { id: string; type: 'delay'; enabled: boolean; params: DelayParams }
  | { id: string; type: 'distortion'; enabled: boolean; params: DistortionParams }

// 面板上旋钮的范围，也是从文件里读回来的参数被夹进的范围。放在这里而不是面板里，是因为这
// 两件事必须是同一组数：一个能被面板拧出来的设置，也必须是文件能存回来的设置。

export const MIN_WET = 0
export const MAX_WET = 1

export const MIN_ROOM_SIZE = 0
export const MAX_ROOM_SIZE = 1

export const MIN_DAMPING = 0
export const MAX_DAMPING = 1

export const MIN_DELAY_SEC = 0
export const MAX_DELAY_SEC = 2

export const MIN_FEEDBACK = 0
/**
 * 反馈量的上限，不是 1。
 *
 * 到 1 就是每一圈原样送回输入，环里的能量一点不减 —— 那是一个永不停止的自己响给自己听的
 * 回路，除了把通道切掉没有别的办法让它停。留一点余量，让它最终还是会自己衰减干净。
 */
export const MAX_FEEDBACK = 0.95

export const MIN_DRIVE = 0
export const MAX_DRIVE = 1

export const MIN_TONE_HZ = 200
export const MAX_TONE_HZ = 20000

export const MIN_OUTPUT_GAIN = 0
export const MAX_OUTPUT_GAIN = 1

/**
 * 三种效果器开箱的参数。
 *
 * 都挑了「一听就听得出来，但不至于糊掉」的位置：混响是一间中等大小、有点软的房间；延迟是
 * 一个能数出拍子但不会盖住原声的三连音时值；失真是能听出脏了但还认得出原来的音色。湿声都
 * 压在 30%，因为加上一个效果器不该是「换了个声音」。
 *
 * 失真那个默认值里 `drive` 和 `outputGain` 的关系说明了一件事：驱动抬小信号，输出增益拉回来。
 */
export const DEFAULT_REVERB_PARAMS: ReverbParams = {
  roomSize: 0.5,
  damping: 0.4,
  wet: 0.3
}

export const DEFAULT_DELAY_PARAMS: DelayParams = {
  timeSec: 0.3,
  feedback: 0.35,
  wet: 0.3
}

export const DEFAULT_DISTORTION_PARAMS: DistortionParams = {
  drive: 0.3,
  toneHz: 4000,
  outputGain: 1
}

/** 添加效果器那一行按钮的顺序，也是这个。 */
export const EFFECT_TYPES: EffectType[] = ['reverb', 'delay', 'distortion']

export const EFFECT_TYPE_LABELS: Record<EffectType, string> = {
  reverb: '混响',
  delay: '延迟',
  distortion: '失真'
}

/** 一句话说明它想做什么声音，鼠标停上去能看到。 */
export const EFFECT_TYPE_HINTS: Record<EffectType, string> = {
  reverb: '给声音加一个房间。房间越大尾巴越长，阻尼越大尾巴越暗',
  delay: '把声音按固定间隔重复。反馈越大重复越久，湿声是重复的音量',
  distortion: '把波形削平长出谐波。驱动是削多少，音调是削完留多少高频'
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(Math.max(value, min), max)
}

export function clampReverbParams(params: ReverbParams): ReverbParams {
  return {
    roomSize: clamp(params.roomSize, MIN_ROOM_SIZE, MAX_ROOM_SIZE),
    damping: clamp(params.damping, MIN_DAMPING, MAX_DAMPING),
    wet: clamp(params.wet, MIN_WET, MAX_WET)
  }
}

export function clampDelayParams(params: DelayParams): DelayParams {
  return {
    timeSec: clamp(params.timeSec, MIN_DELAY_SEC, MAX_DELAY_SEC),
    feedback: clamp(params.feedback, MIN_FEEDBACK, MAX_FEEDBACK),
    wet: clamp(params.wet, MIN_WET, MAX_WET)
  }
}

export function clampDistortionParams(params: DistortionParams): DistortionParams {
  return {
    drive: clamp(params.drive, MIN_DRIVE, MAX_DRIVE),
    toneHz: clamp(params.toneHz, MIN_TONE_HZ, MAX_TONE_HZ),
    outputGain: clamp(params.outputGain, MIN_OUTPUT_GAIN, MAX_OUTPUT_GAIN)
  }
}

/**
 * 把一份参数夹进合法范围，放回它属于的那一格上。
 *
 * 参数的形状由效果器的 `type` 决定，而面板是按 `type` 分支出对应子面板的 —— 交给它的是那个
 * 分支的参数，所以 `params` 和 `effect.type` 说的必然是同一件事，这里的断言成立。断言只写在
 * 这一处，是为了让别处都不必再断言：面板、工程文件、撤销都走这一条路进来，出去的都是合法的。
 */
export function withEffectParams(effect: Effect, params: EffectParams): Effect {
  switch (effect.type) {
    case 'reverb':
      return { ...effect, params: clampReverbParams(params as ReverbParams) }
    case 'delay':
      return { ...effect, params: clampDelayParams(params as DelayParams) }
    case 'distortion':
      return { ...effect, params: clampDistortionParams(params as DistortionParams) }
  }
}

/** 新建一格，参数是这一种的默认值。 */
export function makeEffect(type: EffectType): Effect {
  switch (type) {
    case 'reverb':
      return {
        id: crypto.randomUUID(),
        type: 'reverb',
        enabled: true,
        params: { ...DEFAULT_REVERB_PARAMS }
      }
    case 'delay':
      return {
        id: crypto.randomUUID(),
        type: 'delay',
        enabled: true,
        params: { ...DEFAULT_DELAY_PARAMS }
      }
    case 'distortion':
      return {
        id: crypto.randomUUID(),
        type: 'distortion',
        enabled: true,
        params: { ...DEFAULT_DISTORTION_PARAMS }
      }
  }
}

/**
 * 一格效果器的副本：新的 id，参数也是自己的一份。
 *
 * 给「复制通道」用。新 id 是必须的 —— 两格同 id 的效果器在一条链上会让「移动/删除第几个」
 * 无从回答；参数复制一份是必须的，否则调其中一个的旋钮会同时调另一个，那就不是两份效果链了。
 */
export function copyEffect(effect: Effect): Effect {
  switch (effect.type) {
    case 'reverb':
      return { ...effect, id: crypto.randomUUID(), params: { ...effect.params } }
    case 'delay':
      return { ...effect, id: crypto.randomUUID(), params: { ...effect.params } }
    case 'distortion':
      return { ...effect, id: crypto.randomUUID(), params: { ...effect.params } }
  }
}
