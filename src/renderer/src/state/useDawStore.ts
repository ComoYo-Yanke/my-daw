import { create } from 'zustand'
import { decodeAudioData, playBuffer, resumeAudioContext, stopPlayback } from '../audio/engine'

/** A decoded sample held in memory. */
export type Sample = {
  id: string
  /** File name, shown in the list. */
  name: string
  /** Absolute path on disk, used as the identity of the file in messages. */
  path: string
  /** Length in seconds, taken from the decoded AudioBuffer. */
  durationSec: number
  /** Decoded PCM, ready to schedule. */
  buffer: AudioBuffer
}

type DawState = {
  samples: Sample[]
  /** id of the sample currently audible, or null when silent. */
  playingSampleId: string | null
  isImporting: boolean
  /** Last user-facing failure, cleared by `clearError`. */
  error: string | null
  importSamples: () => Promise<void>
  toggleSample: (id: string) => Promise<void>
  stop: () => void
  clearError: () => void
}

/**
 * IPC hands the file over as a Uint8Array, which may be a view over a larger
 * buffer. decodeAudioData needs an ArrayBuffer covering exactly those bytes.
 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

export const useDawStore = create<DawState>((set, get) => ({
  samples: [],
  playingSampleId: null,
  isImporting: false,
  error: null,

  importSamples: async () => {
    set({ isImporting: true, error: null })

    try {
      const files = await window.api.openSampleFiles()
      if (files.length === 0) {
        // User cancelled the dialog.
        set({ isImporting: false })
        return
      }

      // Still inside the click gesture, so this is allowed to resume.
      await resumeAudioContext()

      const imported: Sample[] = []
      const failed: string[] = []

      for (const file of files) {
        try {
          const buffer = await decodeAudioData(toArrayBuffer(file.data))
          imported.push({
            id: crypto.randomUUID(),
            name: file.name,
            path: file.path,
            durationSec: buffer.duration,
            buffer
          })
        } catch {
          failed.push(file.name)
        }
      }

      set((state) => ({
        samples: [...state.samples, ...imported],
        isImporting: false,
        error: failed.length > 0 ? `无法解码：${failed.join('、')}` : null
      }))
    } catch (cause) {
      set({ isImporting: false, error: `导入失败：${errorMessage(cause)}` })
    }
  },

  toggleSample: async (id) => {
    if (get().playingSampleId === id) {
      stopPlayback()
      set({ playingSampleId: null })
      return
    }

    const sample = get().samples.find((item) => item.id === id)
    if (!sample) return

    await resumeAudioContext()
    // playBuffer cuts any current source first, so the previous sample's
    // onEnded callback will not fire and cannot clobber the new state.
    playBuffer(sample.buffer, () => {
      if (get().playingSampleId === id) {
        set({ playingSampleId: null })
      }
    })
    set({ playingSampleId: id })
  },

  stop: () => {
    stopPlayback()
    set({ playingSampleId: null })
  },

  clearError: () => set({ error: null })
}))
