import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

/**
 * One file read by the main process.
 *
 * `path` is the file's identity as the renderer knows it, which is not always an
 * absolute path: for the pack that ships with the app it is the path relative to
 * that pack. It echoes back whatever was asked for, and that is what makes a
 * single shape serve both.
 */
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

/** One sample the scan found in the user's folder. */
type ScannedSample = {
  path: string
  name: string
  /** The subfolder it came from, or '' for one at the top level. */
  category: string
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
   * Read files out of the sample pack that ships inside the app.
   *
   * The paths are relative to that pack and come back the same way, so the
   * renderer never has to know where the app was installed. Used by the library's
   * file-backed samples; the synthesised ones read nothing.
   */
  readBundledSamples: (paths: string[]): Promise<SampleFilePayload[]> =>
    ipcRenderer.invoke('samples:read-bundled', paths),
  /**
   * Write a project. A null `path` opens the save dialog; a path writes straight
   * over that file. Resolves to null if the dialog was cancelled.
   */
  saveProject: (json: string, path: string | null): Promise<{ path: string } | null> =>
    ipcRenderer.invoke('project:save', json, path),
  /** Show the open dialog and read the chosen project. Null if it was cancelled. */
  openProject: (): Promise<OpenedProject | null> => ipcRenderer.invoke('project:open'),
  /**
   * Read the app's own settings. An empty object when there are none, which is
   * what a first run looks like.
   */
  readSettings: (): Promise<Record<string, unknown>> => ipcRenderer.invoke('settings:read'),
  /** Write the app's settings. Separate from the project, and outlives it. */
  writeSettings: (settings: Record<string, unknown>): Promise<void> =>
    ipcRenderer.invoke('settings:write', settings),
  /** Show the folder picker for the user's sample library. Null if cancelled. */
  chooseSampleFolder: (): Promise<string | null> => ipcRenderer.invoke('samples:choose-folder'),
  /** List the audio files in a folder, one level deep. */
  scanSampleFolder: (folder: string): Promise<ScannedSample[]> =>
    ipcRenderer.invoke('samples:scan-folder', folder),
  /** Ask whether unsaved changes may be discarded. */
  confirmDiscard: (): Promise<boolean> => ipcRenderer.invoke('project:confirm-discard'),
  /**
   * Show the save dialog for an exported mix and return the chosen path.
   *
   * Null if it was cancelled. Nothing is written here — the render only starts
   * once there is a path to write it to.
   */
  chooseExportPath: (defaultName: string, format: 'wav' | 'mp3'): Promise<string | null> =>
    ipcRenderer.invoke('export:choosePath', defaultName, format),
  /** Write finished audio bytes to a path the user picked. */
  writeExportFile: (data: Uint8Array, path: string): Promise<void> =>
    ipcRenderer.invoke('export:writeFile', data, path)
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
