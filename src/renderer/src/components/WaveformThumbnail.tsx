import { useEffect, useRef } from 'react'

type WaveformThumbnailProps = {
  /** Cached peak envelope from `computePeaks`, values 0..1. */
  peaks: Float32Array
  isPlaying: boolean
}

/**
 * Draws a sample's peak envelope as a mirrored bar waveform.
 *
 * Renders a bare <canvas> so it can sit inside the row's play button, and sizes
 * the pixel buffer to the CSS box (via ResizeObserver) so it stays crisp on
 * HiDPI displays and on window resize. Layout size is owned by CSS.
 */
function WaveformThumbnail({ peaks, isPlaying }: WaveformThumbnailProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const draw = (): void => {
      const rect = canvas.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return

      const ratio = window.devicePixelRatio || 1
      canvas.width = Math.round(rect.width * ratio)
      canvas.height = Math.round(rect.height * ratio)

      const context = canvas.getContext('2d')
      if (!context) return
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
      context.clearRect(0, 0, rect.width, rect.height)

      const middle = rect.height / 2
      const usableHeight = Math.max(1, rect.height - 2)
      context.fillStyle = isPlaying ? '#6c8cff' : '#8d97b5'

      // One bar per CSS pixel. Each bar takes the max of the peak buckets it
      // covers, so any row width stays representative of the whole sample.
      const bars = Math.max(1, Math.floor(rect.width))
      const bucketsPerBar = peaks.length / bars

      for (let bar = 0; bar < bars; bar++) {
        const from = Math.floor(bar * bucketsPerBar)
        const to = Math.max(from + 1, Math.floor((bar + 1) * bucketsPerBar))

        let peak = 0
        for (let index = from; index < to && index < peaks.length; index++) {
          if (peaks[index] > peak) peak = peaks[index]
        }

        // Never fully collapse: a silent stretch should still read as a line.
        const height = Math.max(1, peak * usableHeight)
        context.fillRect(bar, middle - height / 2, 1, height)
      }
    }

    draw()
    const observer = new ResizeObserver(draw)
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [peaks, isPlaying])

  return <canvas className="waveform" ref={canvasRef} />
}

export default WaveformThumbnail
