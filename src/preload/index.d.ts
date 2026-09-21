import { ElectronAPI } from '@electron-toolkit/preload'

/** One file read from disk by the main process, as received over IPC. */
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

/** Mirrors the `api` object exposed by src/preload/index.ts. */
export type DawApi = {
  openSampleFiles: () => Promise<SampleFilePayload[]>
  readSampleFiles: (paths: string[]) => Promise<SampleFilePayload[]>
  saveProject: (json: string, path: string | null) => Promise<{ path: string } | null>
  openProject: () => Promise<OpenedProject | null>
  confirmDiscard: () => Promise<boolean>
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: DawApi
  }
}
