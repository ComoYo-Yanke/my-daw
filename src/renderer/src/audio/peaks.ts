/** Resolution of the cached peak envelope — finer than any realistic row width. */
export const PEAK_BUCKETS = 512

/**
 * Reduce a decoded buffer to a peak envelope: for each bucket, the largest
 * absolute sample value across all channels.
 *
 * This is one pass over the PCM, so it runs once per sample at import time and
 * the result is cached on the sample — drawing a thumbnail then costs nothing.
 */
export function computePeaks(buffer: AudioBuffer, buckets = PEAK_BUCKETS): Float32Array {
  const peaks = new Float32Array(buckets)
  const channels: Float32Array[] = []
  for (let index = 0; index < buffer.numberOfChannels; index++) {
    channels.push(buffer.getChannelData(index))
  }

  for (let bucket = 0; bucket < buckets; bucket++) {
    const start = Math.floor((bucket * buffer.length) / buckets)
    // At least one sample per bucket, so very short buffers still show a shape.
    const end = Math.max(start + 1, Math.floor(((bucket + 1) * buffer.length) / buckets))

    let max = 0
    for (const data of channels) {
      for (let i = start; i < end && i < buffer.length; i++) {
        const value = data[i] < 0 ? -data[i] : data[i]
        if (value > max) max = value
      }
    }
    peaks[bucket] = max
  }

  return peaks
}
