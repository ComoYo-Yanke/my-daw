import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { readFile } from 'fs/promises'
import { basename, join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'

/** Extensions Chromium's decoder can handle in the renderer. */
const AUDIO_EXTENSIONS = ['wav', 'mp3', 'ogg', 'oga', 'opus', 'flac', 'm4a', 'aac', 'webm']

/**
 * Show the file picker and read the chosen files.
 *
 * Deliberately does no audio work: it returns raw bytes, and the renderer
 * decodes them. Files that cannot be read are skipped and logged.
 */
async function openSampleFiles(): Promise<{ path: string; name: string; data: Uint8Array }[]> {
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

  const files: { path: string; name: string; data: Uint8Array }[] = []
  for (const filePath of filePaths) {
    try {
      files.push({ path: filePath, name: basename(filePath), data: await readFile(filePath) })
    } catch (error) {
      console.error(`[main] 读取文件失败 ${filePath}:`, error)
    }
  }
  return files
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
