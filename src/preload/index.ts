import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

type SampleFilePayload = {
  path: string
  name: string
  data: Uint8Array
}

/**
 * Renderer-facing API. Thin ipcRenderer wrappers only — no business logic and
 * no audio handling here. Keep the shape in sync with `index.d.ts`.
 */
const api = {
  /** Open the file picker and read the chosen files as raw bytes. */
  openSampleFiles: (): Promise<SampleFilePayload[]> => ipcRenderer.invoke('samples:open')
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
