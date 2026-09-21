import { app, shell, BrowserWindow, ipcMain, dialog, Menu } from 'electron'
import { readFile, readdir, writeFile } from 'fs/promises'
import type { Dirent } from 'fs'
import { basename, extname, join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'

/** Extensions Chromium's decoder can handle in the renderer. */
const AUDIO_EXTENSIONS = ['wav', 'mp3', 'ogg', 'oga', 'opus', 'flac', 'm4a', 'aac', 'webm']

/** What a project file is called on disk. */
const PROJECT_EXTENSION = 'mydaw'

/** What an exported mix can be written as, and what to call each in the dialog. */
const EXPORT_FORMATS: Record<string, { name: string; extension: string }> = {
  wav: { name: 'WAV 音频', extension: 'wav' },
  mp3: { name: 'MP3 音频', extension: 'mp3' }
}

/** One file read from disk, on its way to the renderer. */
type FilePayload = { path: string; name: string; data: Uint8Array }

/**
 * Read files by path, skipping — and logging — the ones that will not open.
 *
 * The renderer learns which paths did not come back and marks those channels as
 * missing, so a file that has been moved is a normal outcome here rather than an
 * error worth throwing over.
 */
async function readFiles(paths: string[]): Promise<FilePayload[]> {
  const files: FilePayload[] = []
  for (const path of paths) {
    try {
      files.push({ path, name: basename(path), data: await readFile(path) })
    } catch (error) {
      console.error(`[main] 读取文件失败 ${path}:`, error)
    }
  }
  return files
}

/**
 * Show the file picker and read the chosen samples.
 *
 * Deliberately does no audio work: it returns raw bytes, and the renderer
 * decodes them.
 */
async function openSampleFiles(): Promise<FilePayload[]> {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: '导入采样',
    buttonLabel: '导入',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '音频文件', extensions: AUDIO_EXTENSIONS },
      { name: '所有文件', extensions: ['*'] }
    ]
  })

  if (canceled || filePaths.length === 0) return []
  return readFiles(filePaths)
}

/**
 * Write a project file, asking for a path when it does not have one yet.
 *
 * A null `path` means the project has never been saved, or the user asked for
 * 另存为 — that is the only difference between the two menu entries. Returns
 * which file was written, or null if the dialog was cancelled.
 */
async function saveProject(json: string, path: string | null): Promise<{ path: string } | null> {
  let target = path

  if (target === null) {
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: '保存工程',
      buttonLabel: '保存',
      defaultPath: `未命名.${PROJECT_EXTENSION}`,
      filters: [{ name: 'my-daw 工程', extensions: [PROJECT_EXTENSION] }]
    })
    if (canceled || filePath === undefined) return null
    target = filePath
  }

  await writeFile(target, json, 'utf8')
  return { path: target }
}

/** Show the open dialog and read the project file back. Parsing is the renderer's. */
async function openProject(): Promise<{ path: string; json: string } | null> {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: '打开工程',
    buttonLabel: '打开',
    properties: ['openFile'],
    filters: [
      { name: 'my-daw 工程', extensions: [PROJECT_EXTENSION] },
      { name: '所有文件', extensions: ['*'] }
    ]
  })

  if (canceled || filePaths.length === 0) return null
  const path = filePaths[0]
  return { path, json: await readFile(path, 'utf8') }
}

/**
 * Ask before unsaved work is thrown away. True means "go ahead".
 *
 * A system dialog rather than one drawn in the window, because the click that
 * opened 新建 must not also be able to dismiss the question it raised. The
 * cancel button is the default, so the safe answer is the one a stray Enter
 * gets.
 */
async function confirmDiscard(): Promise<boolean> {
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    buttons: ['放弃改动', '取消'],
    defaultId: 1,
    cancelId: 1,
    message: '当前工程有未保存的改动',
    detail: '继续会丢掉这些改动，且无法撤销。'
  })
  return response === 0
}

/** One sample found in the user's own folder, on its way to the renderer. */
type ScannedSample = { path: string; name: string; category: string }

/** Whether a file is something Chromium's decoder can open. */
function isAudioFile(name: string): boolean {
  return AUDIO_EXTENSIONS.includes(extname(name).slice(1).toLowerCase())
}

/**
 * List the audio files in the user's sample folder.
 *
 * One level deep, and no further. The subfolders are the categories, which is
 * the whole reason to look inside them at all — but a folder pointed at a music
 * library would otherwise walk everything under it, and the sidebar would come
 * back with thousands of entries nobody asked for.
 *
 * A folder that will not open is not an error worth throwing over: it may have
 * been renamed, or be on a drive that is not plugged in. The renderer gets an
 * empty list and says the folder is empty, which is the same thing from where it
 * stands.
 */
async function scanSampleFolder(folder: string): Promise<ScannedSample[]> {
  let items: Dirent[]
  try {
    items = await readdir(folder, { withFileTypes: true })
  } catch (error) {
    console.error(`[main] 采样目录打不开 ${folder}:`, error)
    return []
  }

  const found: ScannedSample[] = []
  const add = (dir: string, entry: string, category: string): void => {
    found.push({ path: join(dir, entry), name: basename(entry, extname(entry)), category })
  }

  for (const item of items) {
    if (!item.isDirectory()) {
      if (isAudioFile(item.name)) add(folder, item.name, '')
      continue
    }

    const sub = join(folder, item.name)
    try {
      for (const child of await readdir(sub, { withFileTypes: true })) {
        if (child.isFile() && isAudioFile(child.name)) add(sub, child.name, item.name)
      }
    } catch (error) {
      console.error(`[main] 读取子目录失败 ${sub}:`, error)
    }
  }

  return found.sort((a, b) => a.name.localeCompare(b.name))
}

/** Show the folder picker. Null if it was cancelled. */
async function chooseSampleFolder(): Promise<string | null> {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: '选择采样目录',
    buttonLabel: '使用这个目录',
    properties: ['openDirectory']
  })
  if (canceled || filePaths.length === 0) return null
  return filePaths[0]
}

/** Where the app's own settings live. Not the project — these outlive it. */
const SETTINGS_FILE = 'settings.json'

/**
 * Read the app's settings.
 *
 * Anything unreadable comes back as an empty object rather than an error: no
 * file yet is the normal state on a first run, and a file someone has edited
 * into invalid JSON is better treated as "no settings" than as a reason the app
 * will not start.
 */
async function readSettings(): Promise<Record<string, unknown>> {
  try {
    const text = await readFile(join(app.getPath('userData'), SETTINGS_FILE), 'utf8')
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

async function writeSettings(settings: Record<string, unknown>): Promise<void> {
  const path = join(app.getPath('userData'), SETTINGS_FILE)
  await writeFile(path, JSON.stringify(settings, null, 2), 'utf8')
}

/**
 * Where to write an exported mix.
 *
 * Asked *before* the render rather than after it. Rendering is the slow part,
 * and a save that turns out to be cancelled at the end of it has spent the whole
 * render for nothing.
 *
 * Returns null if the dialog was cancelled, which is a normal answer here rather
 * than an error — the renderer treats it as "never mind" and leaves the export
 * options where they were.
 */
async function chooseExportPath(defaultName: string, format: string): Promise<string | null> {
  // An unknown format falls back to WAV rather than rejecting: the renderer
  // already encoded the audio by the time this is called, and the filter is a
  // convenience on the dialog, not a rule about what the bytes are.
  const chosen = EXPORT_FORMATS[format] ?? EXPORT_FORMATS.wav

  const { canceled, filePath } = await dialog.showSaveDialog({
    title: '导出音频',
    buttonLabel: '导出',
    defaultPath: defaultName,
    filters: [{ name: chosen.name, extensions: [chosen.extension] }]
  })
  if (canceled || filePath === undefined) return null
  return filePath
}

/**
 * Write an exported mix to disk.
 *
 * No encoding happens here — the renderer hands over finished bytes. The main
 * process has no opinion about what is in them.
 */
async function writeExportFile(data: Uint8Array, path: string): Promise<void> {
  // A copy rather than a view: what arrived over IPC is the renderer's buffer,
  // and `writeFile` is not allowed to see anything that still belongs to it.
  await writeFile(path, Buffer.from(data))
}

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  /**
   * No menu bar.
   *
   * Electron installs a default one — 文件 / 编辑 / 视图 / 窗口 / 帮助 — which is
   * hidden but slides down the moment Alt is pressed. Every entry in it is
   * either a Chromium affordance (reload, devtools, zoom) or a duplicate of a
   * button already in the toolbar, so it is a second set of controls that only
   * appears by accident.
   *
   * The shortcuts that matter are not lost with it: F12 and Ctrl+R come from
   * `optimizer.watchWindowShortcuts` below, which listens on the web contents
   * rather than through the menu.
   *
   * Ignored on macOS, where the system always draws an application menu.
   */
  Menu.setApplicationMenu(null)

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // IPC test
  ipcMain.on('ping', () => console.log('pong'))

  ipcMain.handle('samples:open', () => openSampleFiles())
  // Opening a project reloads the samples it names, which means reading files by
  // path — no dialog in the way.
  ipcMain.handle('samples:read', (_event, paths: string[]) => readFiles(paths))
  ipcMain.handle('project:save', (_event, json: string, path: string | null) =>
    saveProject(json, path)
  )
  ipcMain.handle('project:open', () => openProject())
  ipcMain.handle('project:confirm-discard', () => confirmDiscard())

  // The user's own sample folder, and the one setting that remembers it.
  ipcMain.handle('settings:read', () => readSettings())
  ipcMain.handle('settings:write', (_event, settings: Record<string, unknown>) =>
    writeSettings(settings)
  )
  ipcMain.handle('samples:choose-folder', () => chooseSampleFolder())
  ipcMain.handle('samples:scan-folder', (_event, folder: string) => scanSampleFolder(folder))

  // Exporting audio: a save dialog and a file write, and nothing else. Every
  // sample of the mix is rendered in the renderer, which is the only place the
  // project's audio and state both exist.
  ipcMain.handle('export:choosePath', (_event, defaultName: string, format: string) =>
    chooseExportPath(defaultName, format)
  )
  ipcMain.handle('export:writeFile', (_event, data: Uint8Array, path: string) =>
    writeExportFile(data, path)
  )

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
