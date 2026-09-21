import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { readFile, writeFile } from 'fs/promises'
import { basename, join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'

/** Extensions Chromium's decoder can handle in the renderer. */
const AUDIO_EXTENSIONS = ['wav', 'mp3', 'ogg', 'oga', 'opus', 'flac', 'm4a', 'aac', 'webm']

/** What a project file is called on disk. */
const PROJECT_EXTENSION = 'mydaw'

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

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    autoHideMenuBar: true,
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
