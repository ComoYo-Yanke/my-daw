import { ElectronAPI } from '@electron-toolkit/preload'

/**
 * One file read by the main process, as received over IPC.
 *
 * `path` echoes back whatever was asked for, which is an absolute path for a file
 * on disk and a path relative to the app's own sample pack for one that ships
 * with it. See the matching note in src/preload/index.ts.
 */
export type SampleFilePayload = {
  path: string
  name: string
  data: Uint8Array
}

/** A project file the main process read back, as JSON text. */
export type OpenedProject = {
  path: string
  json: string
}

/** One sample the scan found in the user's folder. */
export type ScannedSample = {
  path: string
  name: string
  /** The subfolder it came from, or '' for one at the top level. */
  category: string
}

/** Mirrors the `api` object exposed by src/preload/index.ts. */
export type DawApi = {
  openSampleFiles: () => Promise<SampleFilePayload[]>
  readSampleFiles: (paths: string[]) => Promise<SampleFilePayload[]>
  readBundledSamples: (paths: string[]) => Promise<SampleFilePayload[]>
  saveProject: (json: string, path: string | null) => Promise<{ path: string } | null>
  openProject: () => Promise<OpenedProject | null>
  readSettings: () => Promise<Record<string, unknown>>
  writeSettings: (settings: Record<string, unknown>) => Promise<void>
  chooseSampleFolder: () => Promise<string | null>
  scanSampleFolder: (folder: string) => Promise<ScannedSample[]>
  confirmDiscard: () => Promise<boolean>
  chooseExportPath: (defaultName: string, format: 'wav' | 'mp3') => Promise<string | null>
  writeExportFile: (data: Uint8Array, path: string) => Promise<void>
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: DawApi
  }
}
