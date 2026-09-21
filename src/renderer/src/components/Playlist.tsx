import { useCallback, useEffect, useRef, useState } from 'react'
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

/**
 * The timeline's geometry, in pixels.
 *
 * Fixed rather than proportional to the container, which is what lets the
 * timeline be longer than the window: a bar is always the same width, so the
 * grid scrolls instead of squeezing. These are handed to the CSS as custom
 * properties, so the drawing and the hit-testing below cannot drift apart.
 */
const BAR_WIDTH_PX = 48
/** The track header column, also pinned to the left edge while scrolling. */
const HEAD_WIDTH_PX = 112
const RULER_HEIGHT_PX = 18
const TRACK_HEIGHT_PX = 34
/** How near the right end a scroll has to get before the timeline grows. */
const GROW_MARGIN_PX = 80

/** An in-flight drag, measured from where the pointer went down. */
type ClipDrag = {
  kind: 'move' | 'resize' | 'trim'
  clipId: string
  pointerStartX: number
  startBar: number
  lengthBars: number
}

/**
 * The song timeline: patterns placed as clips, one row per track.
 *
 * A clip names a pattern and a span of bars on a track, and holds no notes of
 * its own — placing the same pattern twice places two references to it, so
 * editing the pattern changes both. Clips on one track may overlap, and clips on
 * different tracks play together.
 */
function Playlist(): React.JSX.Element {
  const clips = useDawStore((state) => state.playlistClips)
  const patterns = useDawStore((state) => state.patterns)
  const tracks = useDawStore((state) => state.playlistTracks)
  const currentPatternId = useDawStore((state) => state.currentPatternId)
  const selectedClipId = useDawStore((state) => state.selectedClipId)
  // Only song playback drives this cursor; a lone channel sequence has its own.
  const playback = useDawStore((state) => (state.playback?.mode === 'song' ? state.playback : null))

  const addClip = useDawStore((state) => state.addClip)
  const moveClip = useDawStore((state) => state.moveClip)
  const resizeClip = useDawStore((state) => state.resizeClip)
  const trimClipStart = useDawStore((state) => state.trimClipStart)
  const removeClip = useDawStore((state) => state.removeClip)
  const selectClip = useDawStore((state) => state.selectClip)
  const addTrack = useDawStore((state) => state.addTrack)
  const removeTrack = useDawStore((state) => state.removeTrack)
  const toggleTrackMute = useDawStore((state) => state.toggleTrackMute)
  const toggleTrackSolo = useDawStore((state) => state.toggleTrackSolo)
  const growPlaylist = useDawStore((state) => state.growPlaylist)
  const playSong = useDawStore((state) => state.playSong)
  const stopSequence = useDawStore((state) => state.stopSequence)

  const gridRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<ClipDrag | null>(null)
  // Mirrors the ref for rendering only: the geometry lives in the ref so that
  // a drag does not re-render on every pointer move.
  const [draggingClipId, setDraggingClipId] = useState<string | null>(null)
  /**
   * Whether the automatic growth has already been asked for at this end.
   *
   * Cleared as soon as a scroll lands away from the end, so one press against
   * the right edge grows once rather than once per scroll event, and carrying on
   * scrolling after that grows again.
   */
  const growAskedRef = useRef(false)

  const playheadSec = usePlayheadSec(playback)
  const currentPattern = patterns.find((pattern) => pattern.id === currentPatternId)
  // The timeline is measured in bars, so its length in seconds follows the
  // tempo rather than being fixed when the module loads.
  const bpm = useDawStore((state) => state.bpm)
  // As long as the longest pattern and as far as the furthest clip.
  const playlistBars = useDawStore(selectPlaylistBars)
  const songLengthSec = playlistBars * secondsPerBar(bpm)
  const barSec = secondsPerBar(bpm)

  /**
   * Which track a point is over.
   *
   * Worked out from the grid's own geometry rather than by asking what element is
   * under the pointer: while a clip is being dragged the thing under the pointer
   * is that clip, which is still in the track it is leaving rather than the one
   * it is arriving at.
   */
  const trackAt = useCallback(
    (clientY: number): string | undefined => {
      const grid = gridRef.current
      if (grid === null) return undefined
      const offsetY =
        clientY - grid.getBoundingClientRect().top - RULER_HEIGHT_PX + grid.scrollTop
      const index = Math.floor(offsetY / TRACK_HEIGHT_PX)
      return tracks[Math.min(Math.max(0, index), tracks.length - 1)]?.id
    },
    [tracks]
  )

  /** Drags are tracked on the window, so the pointer may leave the grid. */
  useEffect(() => {
    const handlePointerMove = (event: PointerEvent): void => {
      const drag = dragRef.current
      if (drag === null) return

      // Bars rather than pixels: the same distance means the same number of bars
      // wherever the pointer is, and the arithmetic does not care how long the
      // timeline has grown to.
      const deltaBars = (event.clientX - drag.pointerStartX) / BAR_WIDTH_PX

      if (drag.kind === 'resize') {
        resizeClip(drag.clipId, drag.lengthBars + deltaBars)
        return
      }

      if (drag.kind === 'trim') {
        trimClipStart(drag.clipId, drag.startBar + deltaBars)
        return
      }

      moveClip(drag.clipId, drag.startBar + deltaBars, trackAt(event.clientY))
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
  }, [moveClip, resizeClip, trimClipStart, trackAt])

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
  const handleLanePointerDown = (
    event: React.PointerEvent<HTMLDivElement>,
    trackId: string
  ): void => {
    if (event.button !== 0) return
    const rect = event.currentTarget.getBoundingClientRect()
    selectClip(null)
    addClip(trackId, (event.clientX - rect.left) / BAR_WIDTH_PX)
  }

  /**
   * Reaching the right end grows the timeline.
   *
   * The one place the timeline's length is asked for rather than derived: the
   * clip arithmetic already extends it to fit whatever is placed, but scrolling
   * into empty space has to be able to ask for more of it.
   */
  const handleGridScroll = (event: React.UIEvent<HTMLDivElement>): void => {
    const element = event.currentTarget
    if (element.scrollLeft + element.clientWidth < element.scrollWidth - GROW_MARGIN_PX) {
      growAskedRef.current = false
      return
    }
    if (growAskedRef.current) return
    growAskedRef.current = true
    growPlaylist()
  }

  const gridStyle = {
    '--pl-bar-w': `${BAR_WIDTH_PX}px`,
    '--pl-head-w': `${HEAD_WIDTH_PX}px`,
    '--pl-ruler-h': `${RULER_HEIGHT_PX}px`,
    '--pl-track-h': `${TRACK_HEIGHT_PX}px`,
    '--pl-lane-w': `${playlistBars * BAR_WIDTH_PX}px`,
    '--pl-tracks-h': `${tracks.length * TRACK_HEIGHT_PX}px`
  } as React.CSSProperties

  const playheadBars = Math.min(playlistBars, playheadSec / barSec)

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

        <button
          type="button"
          className="pl__add"
          onClick={growPlaylist}
          title="在时间线末尾再加 8 小节"
        >
          ＋ 增加小节
        </button>
        <button type="button" className="pl__add" onClick={addTrack} title="在下面再加一条轨道">
          ＋ 增加轨道
        </button>

        <span className="pl__counts">
          {tracks.length} 轨 · {playlistBars} 小节
        </span>
        <span className="pl__position">
          {playheadSec.toFixed(2)} / {songLengthSec.toFixed(2)} s
        </span>
        <span className="pl__hint">
          空白处点击放入当前 Pattern（{currentPattern?.name ?? '—'}）· 拖动移动（可跨轨）·
          拖右边缘改长度 · 拖左边缘改起点 · 点选后按 Delete 或右键删除
        </span>
      </header>

      <div className="pl__grid" ref={gridRef} style={gridStyle} onScroll={handleGridScroll}>
        {/* The ruler is offset by the header column so bar 1 starts where the
            lanes do, and pinned to the top so it stays readable while scrolling
            down a stack of tracks. */}
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

        {tracks.map((track) => (
          <div key={track.id} className="pl-track" data-muted={track.muted}>
            <div className="pl-track__head">
              <span className="pl-track__name" title={track.name}>
                {track.name}
              </span>
              <button
                type="button"
                className="pl-track__toggle pl-track__toggle--mute"
                aria-pressed={track.muted}
                onClick={() => toggleTrackMute(track.id)}
                title="静音该轨（下次播放生效）"
              >
                M
              </button>
              <button
                type="button"
                className="pl-track__toggle pl-track__toggle--solo"
                aria-pressed={track.soloed}
                onClick={() => toggleTrackSolo(track.id)}
                title="独奏该轨（下次播放生效）"
              >
                S
              </button>
              <button
                type="button"
                className="pl-track__remove"
                onClick={() => removeTrack(track.id)}
                title="删除该轨（连它上面的 Clip 一起，可 Ctrl+Z 撤销）"
                aria-label={`删除 ${track.name}`}
              >
                ×
              </button>
            </div>

            <div
              className="pl-lane"
              data-track-id={track.id}
              onPointerDown={(event) => handleLanePointerDown(event, track.id)}
            >
              {clips
                .filter((clip) => clip.trackId === track.id)
                .map((clip) => {
                  const pattern = patterns.find((item) => item.id === clip.patternId)
                  // How many times the clip plays its pattern: a clip longer than
                  // its pattern loops it, a shorter one cuts it off.
                  const repeats = Math.ceil(clip.lengthBars / (pattern?.lengthBars ?? 1))
                  return (
                    <div
                      key={clip.id}
                      className="pl-clip"
                      data-selected={clip.id === selectedClipId}
                      data-dragging={clip.id === draggingClipId}
                      style={{
                        left: `${clip.startBar * BAR_WIDTH_PX}px`,
                        width: `${clip.lengthBars * BAR_WIDTH_PX}px`,
                        background: colorForPattern(patterns, clip.patternId)
                      }}
                      title={`${pattern?.name ?? '未知 Pattern'} · 第 ${clip.startBar + 1} 小节起 · ${clip.lengthBars} 小节${repeats > 1 ? `（循环 ${repeats} 次）` : ''}`}
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
                      <span
                        className="pl-clip__handle pl-clip__handle--left"
                        title="拖动改变起点（右端不动）"
                        onPointerDown={(event) =>
                          startDrag(event, {
                            kind: 'trim',
                            clipId: clip.id,
                            pointerStartX: event.clientX,
                            startBar: clip.startBar,
                            lengthBars: clip.lengthBars
                          })
                        }
                      />
                      <span className="pl-clip__label">
                        {pattern?.name ?? '未知'}
                        {repeats > 1 ? ` ×${repeats}` : ''}
                      </span>
                      <span
                        className="pl-clip__handle pl-clip__handle--right"
                        title="拖动改变长度（拖短裁切、拖长循环）"
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
            </div>
          </div>
        ))}

        {/* One line for the whole stack rather than one per lane: it is the same
            moment on every track. Drawn above the lanes and below the headers,
            which are pinned and must stay readable. */}
        {playback !== null && (
          <div
            className="pl-playhead"
            style={{ left: `calc(var(--pl-head-w) + ${playheadBars * BAR_WIDTH_PX}px)` }}
          />
        )}
      </div>
    </section>
  )
}

export default Playlist
