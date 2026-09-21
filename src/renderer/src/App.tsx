import { useDawStore } from './state/useDawStore'
import type { Sample } from './state/useDawStore'

/** Seconds -> m:ss.mmm, e.g. 63.25 -> "1:03.250". */
function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  const rest = seconds - minutes * 60
  return `${minutes}:${rest.toFixed(3).padStart(6, '0')}`
}

type SampleRowProps = {
  sample: Sample
  isPlaying: boolean
  onToggle: (id: string) => Promise<void>
}

function SampleRow({ sample, isPlaying, onToggle }: SampleRowProps): React.JSX.Element {
  return (
    <li className="sample">
      <button
        type="button"
        className={isPlaying ? 'sample__button sample__button--playing' : 'sample__button'}
        onClick={() => {
          void onToggle(sample.id)
        }}
        aria-pressed={isPlaying}
      >
        <span className="sample__icon">{isPlaying ? '◼' : '▶'}</span>
        <span className="sample__name">{sample.name}</span>
        <span className="sample__duration">{formatDuration(sample.durationSec)}</span>
      </button>
    </li>
  )
}

function App(): React.JSX.Element {
  const samples = useDawStore((state) => state.samples)
  const playingSampleId = useDawStore((state) => state.playingSampleId)
  const isImporting = useDawStore((state) => state.isImporting)
  const error = useDawStore((state) => state.error)
  const importSamples = useDawStore((state) => state.importSamples)
  const toggleSample = useDawStore((state) => state.toggleSample)
  const stop = useDawStore((state) => state.stop)
  const clearError = useDawStore((state) => state.clearError)

  return (
    <div className="daw">
      <header className="toolbar">
        <span className="toolbar__title">my-daw</span>
        <button
          type="button"
          className="toolbar__button toolbar__button--primary"
          onClick={() => {
            void importSamples()
          }}
          disabled={isImporting}
        >
          {isImporting ? '导入中…' : '导入采样'}
        </button>
        <button
          type="button"
          className="toolbar__button"
          onClick={stop}
          disabled={playingSampleId === null}
        >
          停止
        </button>
        <span className="toolbar__count">{samples.length} 个采样</span>
      </header>

      {error !== null && (
        <div className="banner" role="alert">
          <span className="banner__text">{error}</span>
          <button type="button" className="banner__close" onClick={clearError}>
            关闭
          </button>
        </div>
      )}

      <main className="content">
        {samples.length === 0 ? (
          <p className="empty">
            还没有采样。点击「导入采样」选择音频文件（wav / mp3 / ogg / flac / m4a）。
          </p>
        ) : (
          <ul className="sample-list">
            {samples.map((sample) => (
              <SampleRow
                key={sample.id}
                sample={sample}
                isPlaying={sample.id === playingSampleId}
                onToggle={toggleSample}
              />
            ))}
          </ul>
        )}
      </main>
    </div>
  )
}

export default App
