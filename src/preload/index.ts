import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

/** One file read from disk by the main process. */
type SampleFilePayload = {
  path: string
  name: string
  data: Uint8Array
}

/** A project file that was read back, as JSON text. */
type OpenedProject = {
  path: string
  json: string
}

/**
 * Renderer-facing API. Thin ipcRenderer wrappers only — no business logic and
 * no audio handling here. Keep the shape in sync with `index.d.ts`.
 */
const api = {
  /** Open the file picker and read the chosen files as raw bytes. */
  openSampleFiles: (): Promise<SampleFilePayload[]> => ipcRenderer.invoke('samples:open'),
  /**
   * Read samples the renderer already knows the paths of.
   *
   * What opening a project needs: the file names the samples it was built from,
   * so there is nothing to ask the user. Paths that will not open are simply
   * absent from what comes back.
   */
  readSampleFiles: (paths: string[]): Promise<SampleFilePayload[]> =>
    ipcRenderer.invoke('samples:read', paths),
  /**
   * Write a project. A null `path` opens the save dialog; a path writes straight
   * over that file. Resolves to null if the dialog was cancelled.
   */
  saveProject: (json: string, path: string | null): Promise<{ path: string } | null> =>
    ipcRenderer.invoke('project:save', json, path),
  /** Show the open dialog and read the chosen project. Null if it was cancelled. */
  openProject: (): Promise<OpenedProject | null> => ipcRenderer.invoke('project:open'),
  /** Ask whether unsaved changes may be discarded. */
  confirmDiscard: (): Promise<boolean> => ipcRenderer.invoke('project:confirm-discard')
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
