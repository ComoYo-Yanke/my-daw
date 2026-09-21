import { ElectronAPI } from '@electron-toolkit/preload'

/** One file read from disk by the main process, as received over IPC. */
export type SampleFilePayload = {
  path: string
  name: string
  data: Uint8Array
}

/** Mirrors the `api` object exposed by src/preload/index.ts. */
export type DawApi = {
  openSampleFiles: () => Promise<SampleFilePayload[]>
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: DawApi
  }
}
