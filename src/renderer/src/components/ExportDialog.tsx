import { useEffect, useState } from 'react'
import {
  encodeMp3,
  encodeWav,
  MP3_BIT_RATES,
  renderMix,
  type ExportBitDepth,
  type ExportFormat,
  type ExportSettings,
  type ExportStage
} from '../audio/export'
import { selectExportPlan, useDawStore } from '../state/useDawStore'
import { MAX_BPM, MIN_BPM } from '../types/note'

type Phase = 'setup' | 'running' | 'done' | 'error'

/**
 * How much of the bar each stage of the job owns.
 *
 * The weights are a guess at where the time goes, but the ratio inside a stage
 * is not: the render and the encode both report real progress, so the bar moves
 * because the work moved rather than because a timer said so.
 */
const STAGES: Record<ExportStage, { from: number; span: number }> = {
  prepare: { from: 0, span: 0.15 },
  render: { from: 0.15, span: 0.6 },
  encode: { from: 0.75, span: 0.25 }
}

/** What a stage is doing, which for the last one depends on the format. */
function stageLabel(stage: ExportStage, format: ExportFormat): string {
  if (stage === 'prepare') return '准备音高'
  if (stage === 'render') return '离线渲染'
  return format === 'mp3' ? '编码 MP3' : '编码 WAV'
}

/** How far along the whole job a stage's own progress puts it. */
function overallProgress(stage: ExportStage, ratio: number): number {
  const { from, span } = STAGES[stage]
  return Math.min(1, from + span * ratio)
}

/**
 * What to call the file before the user renames it.
 *
 * Taken from the project's own name where there is one, so a folder of exports
 * says which song each came from without being opened.
 */
function defaultExportName(projectPath: string | null, format: ExportFormat): string {
  const base = projectPath === null ? '未命名' : (projectPath.split(/[\\/]/).pop() ?? '未命名')
  return `${base.replace(/\.[^.]+$/, '')}.${format}`
}

/** A number field's text, or the value it had while a partial one is typed. */
function numberOr(text: string, fallback: number): number {
  const value = Number(text)
  return Number.isFinite(value) ? value : fallback
}

type ExportDialogProps = {
  onClose: () => void
}

/**
 * 导出音频: the options, then the job, then where it went.
 *
 * The whole export happens here rather than behind a store action, because
 * everything it produces — which phase it is in, how far along, which path it
 * landed in — is about this dialog and nothing else. Nothing outside it has an
 * opinion about a render in progress.
 *
 * The save dialog comes first, before a single sample is rendered. Rendering is
 * the slow part, and a save cancelled at the end of it would have spent the
 * whole render to produce a file nobody wanted.
 *
 * Closing is refused while the job runs: the render cannot be called off
 * halfway without leaving the offline context's promises in the air, and a
 * dialog that vanished mid-render would leave nothing to report the result to.
 */
function ExportDialog({ onClose }: ExportDialogProps): React.JSX.Element {
  const projectBpm = useDawStore((state) => state.bpm)
  const projectPath = useDawStore((state) => state.projectPath)
  const hasClips = useDawStore((state) => state.playlistClips.length > 0)

  const [phase, setPhase] = useState<Phase>('setup')
  const [settings, setSettings] = useState<ExportSettings>({
    format: 'wav',
    sampleRate: 44100,
    bitDepth: 16,
    mp3BitRate: 320,
    gainDb: 0,
    normalize: false,
    tailSec: 0
  })
  /** The tempo to lay the song out at, which is the project's unless changed. */
  const [bpm, setBpm] = useState(projectBpm)
  const [progress, setProgress] = useState(0)
  const [stage, setStage] = useState<ExportStage>('prepare')
  const [savedPath, setSavedPath] = useState<string | null>(null)
  const [message, setMessage] = useState('')

  const running = phase === 'running'

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !running) onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose, running])

  function update<K extends keyof ExportSettings>(key: K, value: ExportSettings[K]): void {
    setSettings((current) => ({ ...current, [key]: value }))
  }

  /** Render, encode, and write. The one place the export's order is decided. */
  async function run(): Promise<void> {
    setPhase('running')
    setProgress(0)

    try {
      const path = await window.api.chooseExportPath(
        defaultExportName(projectPath, settings.format),
        settings.format
      )
      if (path === null) {
        // Cancelled, which is not a failure: back to the options as they were.
        setPhase('setup')
        return
      }

      const tempo = Math.min(Math.max(bpm, MIN_BPM), MAX_BPM)
      const plan = selectExportPlan(useDawStore.getState(), tempo, Math.max(0, settings.tailSec))
      if (plan.voices.length === 0) {
        throw new Error('时间线上没有可以导出的音符')
      }

      const report = (step: { stage: ExportStage; ratio: number }): void => {
        setStage(step.stage)
        setProgress(overallProgress(step.stage, step.ratio))
      }

      const rendered = await renderMix(plan.voices, plan.durationSec, settings, report)
      const bytes =
        settings.format === 'mp3'
          ? await encodeMp3(rendered, settings.mp3BitRate, report)
          : await encodeWav(rendered, settings.bitDepth, report)
      await window.api.writeExportFile(bytes, path)

      setSavedPath(path)
      setPhase('done')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
      setPhase('error')
    }
  }

  return (
    <div
      className="confirm"
      role="dialog"
      aria-modal="true"
      onPointerDown={(event) => {
        // The scrim is a way out; the box on top of it is not. And not while the
        // job is running, for the reason in the comment above.
        if (event.target === event.currentTarget && !running) onClose()
      }}
    >
      <div className="confirm__box export">
        <h2 className="export__title">导出音频</h2>

        {phase === 'setup' && (
          <>
            <p className="export__hint">
              按 Song 时间线渲染：Playlist 上每个片段的位置、Pattern
              里的音符，加上所有通道当前的音量、声像、静音和 solo。
            </p>

            <div className="export__grid">
              <label className="export__row">
                <span className="export__label">格式</span>
                <select
                  className="export__input"
                  value={settings.format}
                  onChange={(event) => update('format', event.target.value as ExportFormat)}
                >
                  <option value="wav">WAV（无损 PCM）</option>
                  <option value="mp3">MP3（有损）</option>
                </select>
              </label>

              <label className="export__row">
                <span className="export__label">采样率</span>
                <select
                  className="export__input"
                  value={settings.sampleRate}
                  onChange={(event) => update('sampleRate', Number(event.target.value))}
                >
                  <option value={44100}>44100 Hz</option>
                  <option value={48000}>48000 Hz</option>
                </select>
              </label>

              {/* One row, two meanings: a lossless format is chosen by its word
                  size, a lossy one by its bit rate. Showing both at once would
                  offer a knob that does nothing. */}
              {settings.format === 'wav' ? (
                <label className="export__row">
                  <span className="export__label">位深</span>
                  <select
                    className="export__input"
                    value={settings.bitDepth}
                    onChange={(event) =>
                      update('bitDepth', Number(event.target.value) as ExportBitDepth)
                    }
                  >
                    <option value={16}>16-bit</option>
                    <option value={24}>24-bit</option>
                  </select>
                </label>
              ) : (
                <label className="export__row">
                  <span className="export__label">码率</span>
                  <select
                    className="export__input"
                    value={settings.mp3BitRate}
                    onChange={(event) => update('mp3BitRate', Number(event.target.value))}
                  >
                    {MP3_BIT_RATES.map((rate) => (
                      <option key={rate} value={rate}>
                        {rate} kbps
                      </option>
                    ))}
                  </select>
                </label>
              )}

              <label className="export__row">
                <span className="export__label">速度</span>
                <span className="export__pair">
                  <input
                    className="export__input"
                    type="number"
                    min={MIN_BPM}
                    max={MAX_BPM}
                    step={1}
                    value={bpm}
                    onChange={(event) => setBpm(numberOr(event.target.value, bpm))}
                    // Clamped here rather than as it is typed: a field that
                    // snapped "1" up to the minimum would make 120 untypeable.
                    onBlur={() => setBpm((value) => Math.min(Math.max(value, MIN_BPM), MAX_BPM))}
                  />
                  <span className="export__unit">BPM</span>
                </span>
              </label>

              <label className="export__row">
                <span className="export__label">响度</span>
                <span className="export__pair">
                  <input
                    className="export__input"
                    type="number"
                    step={0.5}
                    value={settings.gainDb}
                    onChange={(event) =>
                      update('gainDb', numberOr(event.target.value, settings.gainDb))
                    }
                  />
                  <span className="export__unit">dB</span>
                </span>
              </label>

              <label className="export__row">
                <span className="export__label">尾部留白</span>
                <span className="export__pair">
                  <input
                    className="export__input"
                    type="number"
                    min={0}
                    step={0.5}
                    value={settings.tailSec}
                    onChange={(event) =>
                      update('tailSec', Math.max(0, numberOr(event.target.value, settings.tailSec)))
                    }
                  />
                  <span className="export__unit">秒</span>
                </span>
              </label>

              <label className="export__row export__row--check">
                <input
                  type="checkbox"
                  checked={settings.normalize}
                  onChange={(event) => update('normalize', event.target.checked)}
                />
                <span>峰值归一化到 −1 dBFS</span>
              </label>
            </div>

            {/* What the settings are relative to, so the two numbers that have a
                sensible default are not guessed at. */}
            <p className="export__note">
              速度 {bpm} BPM，工程是 {projectBpm} BPM；响度 0 dB 是原始音量。
            </p>

            {!hasClips && (
              <p className="export__note export__note--warn">
                时间线上还没有片段，先到 Song 窗口里放一个 Pattern。
              </p>
            )}

            <div className="confirm__actions">
              <button type="button" className="confirm__button" onClick={onClose} autoFocus>
                取消
              </button>
              <button
                type="button"
                className="confirm__button confirm__button--danger"
                onClick={() => {
                  void run()
                }}
                disabled={!hasClips}
              >
                选择位置并导出
              </button>
            </div>
          </>
        )}

        {running && (
          <>
            <p className="export__stage">
              {stageLabel(stage, settings.format)}… {Math.round(progress * 100)}%
            </p>
            <div className="export__bar">
              <div className="export__fill" style={{ width: `${progress * 100}%` }} />
            </div>
            <p className="export__note">
              渲染在离线上下文里跑，比实时快得多。导出期间请不要关闭窗口。
            </p>
          </>
        )}

        {phase === 'done' && (
          <>
            <p className="export__stage">已导出到</p>
            {/* Selectable: the point of showing a path is to be able to copy it. */}
            <p className="export__path">{savedPath}</p>
            <div className="confirm__actions">
              <button type="button" className="confirm__button" onClick={onClose} autoFocus>
                完成
              </button>
            </div>
          </>
        )}

        {phase === 'error' && (
          <>
            <p className="export__stage">导出失败</p>
            <p className="export__path">{message}</p>
            <div className="confirm__actions">
              <button
                type="button"
                className="confirm__button"
                onClick={() => setPhase('setup')}
                autoFocus
              >
                返回
              </button>
              <button type="button" className="confirm__button" onClick={onClose}>
                关闭
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export default ExportDialog
