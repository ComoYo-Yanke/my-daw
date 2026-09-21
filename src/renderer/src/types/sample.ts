// How a sample is played at a pitch.
//
// A sample is not necessarily one recording stretched over the whole keyboard. A
// real instrument is recorded note by note: each zone is a recording of its own
// pitch, and only the notes that fall *between* two recordings are shifted to
// get there. So playing a note is two questions — which zone, and how much is
// left to shift by — and `voiceForPitch` is both of them at once.
//
// A sample synthesised in code goes down the same path: it has exactly one zone,
// at 0, so every note shifts by its whole pitch. That is what it has always
// done, which is why nothing above this has to know where a sample came from.

/** One recording, and the pitch it was recorded at. */
export type SampleZone = {
  /**
   * This recording's own pitch, as semitones from the sample's reference pitch —
   * 0 is the reference itself.
   *
   * The reference is the piano roll's offset 0: the roll calls a sample's own
   * pitch C4, so the recording of C4 is the zone at 0.
   */
  pitch: number
  buffer: AudioBuffer
}

/** The recording a note plays, and how far it still has to be shifted. */
export type SampleVoice = {
  buffer: AudioBuffer
  /** Semitones, positive for up. Already has the zone's own pitch taken out. */
  shift: number
}

/**
 * An ordinary one-file sample, in the shape the engine takes.
 *
 * A single zone at the reference pitch, so every note shifts by its own pitch —
 * which is what a plain sample has always done, and what makes it the same
 * shape as a multisampled instrument everywhere above this.
 */
export function singleZone(buffer: AudioBuffer): SampleZone[] {
  return [{ pitch: 0, buffer }]
}

/**
 * Pick the zone a note at `pitch` plays.
 *
 * Nearest rather than the one below: a zone covers half a gap either side of
 * itself, so the nearest one is the one that has to shift the least to reach the
 * note — and shifting is what costs quality.
 *
 * `zones` must not be empty. A sample with no recordings is not a sample, and
 * every caller has one in hand before it gets here.
 */
export function voiceForPitch(zones: SampleZone[], pitch: number): SampleVoice {
  let best = zones[0]
  for (const zone of zones) {
    if (Math.abs(zone.pitch - pitch) < Math.abs(best.pitch - pitch)) best = zone
  }
  return { buffer: best.buffer, shift: pitch - best.pitch }
}
