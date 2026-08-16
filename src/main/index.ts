import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme } from 'electron'
import { basename, join } from 'node:path'
import { JsonFile, JsonError } from './jsonFile'
import type { ItemResponse, OpenResponse } from '../shared/types'

let mainWindow: BrowserWindow | null = null
let currentFile: JsonFile | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 720,
    minWidth: 640,
    minHeight: 480,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#17181c' : '#f7f7f9',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    title: 'JSON Reader',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
    void closeCurrentFile()
  })
  mainWindow.on('ready-to-show', () => mainWindow?.show())
  // The renderer is a local, read-only view; it never navigates anywhere.
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin'
  const requestOpen = (): void => {
    mainWindow?.webContents.send('open-json-requested')
  }

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open JSON…', accelerator: 'CmdOrCtrl+O', click: requestOpen },
        { type: 'separator' },
        { role: isMac ? 'close' : 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [{ role: 'copy' }, { role: 'selectAll' }]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

async function closeCurrentFile(): Promise<void> {
  if (currentFile) {
    const file = currentFile
    currentFile = null
    await file.close()
  }
}

ipcMain.handle('json:open', async (): Promise<OpenResponse> => {
  const win = mainWindow
  if (!win) return { status: 'canceled' }

  const picked = await dialog.showOpenDialog(win, {
    title: 'Open JSON file',
    properties: ['openFile'],
    filters: [
      { name: 'JSON', extensions: ['json'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  })
  if (picked.canceled || picked.filePaths.length === 0) return { status: 'canceled' }

  const path = picked.filePaths[0]
  const fileName = basename(path)
  try {
    if (!/\.json$/i.test(path)) {
      return { status: 'error', fileName, error: 'Unsupported file: expected a .json file.' }
    }
    await closeCurrentFile()
    const file = await JsonFile.open(path)
    currentFile = file
    return { status: 'ok', fileName, root: file.root }
  } catch (err) {
    currentFile = null
    const message = err instanceof JsonError ? err.message : 'The file could not be read.'
    return { status: 'error', fileName, error: message }
  }
})

ipcMain.handle('json:get-item', (_event, index: unknown): Promise<ItemResponse> => {
  if (!currentFile || typeof index !== 'number' || !Number.isInteger(index)) {
    return Promise.resolve({ status: 'error', error: 'No file is open.' })
  }
  return currentFile
    .item(index)
    .then((value): ItemResponse => ({ status: 'ok', value }))
    .catch((err: unknown): ItemResponse => ({
      status: 'error',
      error: err instanceof JsonError ? err.message : `Item ${index + 1} could not be read.`
    }))
})

void app.whenReady().then(() => {
  buildMenu()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
