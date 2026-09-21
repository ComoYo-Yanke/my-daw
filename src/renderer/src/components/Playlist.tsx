import { useEffect, useRef, useState } from 'react'
import { usePlayheadSec } from '../hooks/usePlayheadSec'
import { selectPlaylistBars, useDawStore } from '../state/useDawStore'
import type { Pattern } from '../state/useDawStore'
import { BEATS_PER_BAR, secondsPerBar } from '../types/note'

/**
 * Clip colours, handed out by the pattern's position in the list.
 *
 * Position rather than a stored colour, so the palette stays a presentation
 * detail and patterns keep their colour for the life of the session.
 */
const CLIP_COLORS = [
  '#6c8cff',
  '#48b57a',
  '#e0a33c',
  '#d96a9c',
  '#5cc8d6',
  '#a97ce0',
  '#e07a5f',
  '#8fbf4a'
]

function colorForPattern(patterns: Pattern[], patternId: string): string {
  const index = patterns.findIndex((pattern) => pattern.id === patternId)
  return CLIP_COLORS[Math.max(0, index) % CLIP_COLORS.length]
}

/** An in-flight drag, measured from where the pointer went down. */
type ClipDrag = {
  kind: 'move' | 'resize'
  clipId: string
  pointerStartX: number
  startBar: number
  lengthBars: number
}

/**
 * The song timeline: patterns placed as clips along a bar ruler.
 *
 * A single lane, which is what `PlaylistClip` describes — a clip names a pattern
 * and a span of bars, not a track. Clips therefore never overlap.
 */
function Playlist(): React.JSX.Element {
  const clips = useDawStore((state) => state.playlistClips)
  const patterns = useDawStore((state) => state.patterns)
  const currentPatternId = useDawStore((state) => state.currentPatternId)
  const selectedClipId = useDawStore((state) => state.selectedClipId)
  // Only song playback drives this cursor; a lone channel sequence has its own.
  const playback = useDawStore((state) => (state.playback?.mode === 'song' ? state.playback : null))

  const addClip = useDawStore((state) => state.addClip)
  const moveClip = useDawStore((state) => state.moveClip)
  const resizeClip = useDawStore((state) => state.resizeClip)
  const removeClip = useDawStore((state) => state.removeClip)
  const selectClip = useDawStore((state) => state.selectClip)
  const playSong = useDawStore((state) => state.playSong)
  const stopSequence = useDawStore((state) => state.stopSequence)

  const laneRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<ClipDrag | null>(null)
  // Mirrors the ref for rendering only: the geometry lives in the ref so that
  // a drag does not re-render on every pointer move.
  const [draggingClipId, setDraggingClipId] = useState<string | null>(null)

  const playheadSec = usePlayheadSec(playback)
  const currentPattern = patterns.find((pattern) => pattern.id === currentPatternId)
  // The timeline is measured in bars, so its length in seconds follows the
  // tempo rather than being fixed when the module loads.
  const bpm = useDawStore((state) => state.bpm)
  // As long as the longest pattern, so a clip of any of them has room.
  const playlistBars = useDawStore(selectPlaylistBars)
  const songLengthSec = playlistBars * secondsPerBar(bpm)

  /** Drags are tracked on the window, so the pointer may leave the lane. */
  useEffect(() => {
    const handlePointerMove = (event: PointerEvent): void => {
      const drag = dragRef.current
      const lane = laneRef.current
      if (!drag || !lane) return

      const rect = lane.getBoundingClientRect()
      if (rect.width === 0) return
      const deltaBars = ((event.clientX - drag.pointerStartX) / rect.width) * playlistBars

      if (drag.kind === 'resize') {
        resizeClip(drag.clipId, drag.lengthBars + deltaBars)
      } else {
        moveClip(drag.clipId, drag.startBar + deltaBars)
      }
    }

    const handlePointerUp = (): void => {
      dragRef.current = null
      setDraggingClipId(null)
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerUp)
    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerUp)
    }
  }, [moveClip, resizeClip, playlistBars])

  /** Delete removes the selected clip, the way the piano roll's right-click does. */
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (selectedClipId === null) return
      if (event.key !== 'Delete' && event.key !== 'Backspace') return
      // Never steal the key from the pattern rename box.
      if ((event.target as HTMLElement | null)?.closest('input, textarea') != null) return
      event.preventDefault()
      removeClip(selectedClipId)
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [selectedClipId, removeClip])

  const startDrag = (event: React.PointerEvent, drag: ClipDrag): void => {
    if (event.button !== 0) return
    // Keeps the lane from treating this as a click on empty space.
    event.stopPropagation()
    selectClip(drag.clipId)
    dragRef.current = drag
    setDraggingClipId(drag.clipId)
  }

  /** A click on empty lane drops the current pattern there. */
  const handleLanePointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    const rect = event.currentTarget.getBoundingClientRect()
    if (rect.width === 0) return
    selectClip(null)
    addClip(((event.clientX - rect.left) / rect.width) * playlistBars)
  }

  const laneStyle = {
    '--pl-bar-w': `${100 / playlistBars}%`,
    '--pl-beat-w': `${100 / (playlistBars * BEATS_PER_BAR)}%`,
    '--pl-group-w': `${100 / (playlistBars / BEATS_PER_BAR)}%`
  } as React.CSSProperties

  return (
    <section className="playlist" aria-label="播放列表">
      <header className="pl__header">
        <span className="pl__title">Playlist</span>
        <button
          type="button"
          className="pl__play"
          onClick={() => {
            if (playback !== null) {
              stopSequence()
            } else {
              void playSong()
            }
          }}
          disabled={clips.length === 0}
          aria-pressed={playback !== null}
          title={clips.length === 0 ? '先在时间线上放一个 Clip' : '播放 / 暂停整首歌'}
        >
          {playback !== null ? '⏸ 暂停' : '▶ 播放'}
        </button>
        <span className="pl__position">
          {playheadSec.toFixed(2)} / {songLengthSec.toFixed(2)} s
        </span>
        <span className="pl__hint">
          空白处点击放入当前 Pattern（{currentPattern?.name ?? '—'}）· 拖动移动 · 拖右边缘改长度 ·
          点选后按 Delete 或右键删除
        </span>
      </header>

      <div className="pl__body">
        <div className="pl__ruler">
          {Array.from({ length: playlistBars }, (_, index) => (
            <span
              key={index}
              className="pl__ruler-bar"
              data-group={(index + 1) % BEATS_PER_BAR === 1}
            >
              {index + 1}
            </span>
          ))}
        </div>

        <div
          className="pl-lane"
          ref={laneRef}
          style={laneStyle}
          onPointerDown={handleLanePointerDown}
        >
          {clips.map((clip) => {
            const pattern = patterns.find((item) => item.id === clip.patternId)
            // How many times the clip plays its pattern, which is its length in
            // that pattern's own bars rather than in a project-wide one.
            const repeats = Math.max(
              1,
              Math.round(clip.lengthBars / (pattern?.lengthBars ?? clip.lengthBars))
            )
            return (
              <div
                key={clip.id}
                className="pl-clip"
                data-selected={clip.id === selectedClipId}
                data-dragging={clip.id === draggingClipId}
                style={{
                  left: `${(clip.startBar / playlistBars) * 100}%`,
                  width: `${(clip.lengthBars / playlistBars) * 100}%`,
                  background: colorForPattern(patterns, clip.patternId)
                }}
                title={`${pattern?.name ?? '未知 Pattern'} · 第 ${clip.startBar + 1} 小节起 · ${clip.lengthBars} 小节`}
                onPointerDown={(event) =>
                  startDrag(event, {
                    kind: 'move',
                    clipId: clip.id,
                    pointerStartX: event.clientX,
                    startBar: clip.startBar,
                    lengthBars: clip.lengthBars
                  })
                }
                onContextMenu={(event) => {
                  event.preventDefault()
                  removeClip(clip.id)
                }}
              >
                <span className="pl-clip__label">
                  {pattern?.name ?? '未知'}
                  {repeats > 1 ? ` ×${repeats}` : ''}
                </span>
                <span
                  className="pl-clip__handle"
                  title="拖动改变长度（Pattern 的整数倍）"
                  onPointerDown={(event) =>
                    startDrag(event, {
                      kind: 'resize',
                      clipId: clip.id,
                      pointerStartX: event.clientX,
                      startBar: clip.startBar,
                      lengthBars: clip.lengthBars
                    })
                  }
                />
              </div>
            )
          })}

          {playback !== null && (
            <div
              className="pl-playhead"
              style={{ left: `${Math.min(100, (playheadSec / songLengthSec) * 100)}%` }}
            />
          )}
        </div>
      </div>
    </section>
  )
}

export default Playlist
