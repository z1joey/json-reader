import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme } from 'electron'
import { readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { JsonFile, JsonError } from './jsonFile'
import type { ItemResponse, OpenFileResponse, OpenResponse, SearchResponse } from '../shared/types'

let mainWindow: BrowserWindow | null = null
let currentFile: JsonFile | null = null
let currentFolderFiles: string[] | null = null
let searchSeq = 0

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

/** Opens `path` as the current file, replacing whatever was open before. */
async function openJsonFile(path: string): Promise<OpenFileResponse> {
  const fileName = basename(path)
  try {
    await closeCurrentFile()
    const file = await JsonFile.open(path)
    currentFile = file
    return { status: 'ok', fileName, root: file.root }
  } catch (err) {
    currentFile = null
    const message = err instanceof JsonError ? err.message : 'The file could not be read.'
    return { status: 'error', fileName, error: message }
  }
}

ipcMain.handle('json:open', async (): Promise<OpenResponse> => {
  const win = mainWindow
  if (!win) return { status: 'canceled' }

  const picked = await dialog.showOpenDialog(win, {
    title: 'Open JSON file',
    properties: ['openFile', 'openDirectory'],
    filters: [
      { name: 'JSON', extensions: ['json'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  })
  if (picked.canceled || picked.filePaths.length === 0) return { status: 'canceled' }

  const path = picked.filePaths[0]
  let isDirectory: boolean
  try {
    isDirectory = (await stat(path)).isDirectory()
  } catch {
    return { status: 'error', fileName: basename(path), error: 'The path could not be read.' }
  }

  if (!isDirectory) {
    if (!/\.json$/i.test(path)) {
      return { status: 'error', fileName: basename(path), error: 'Unsupported file: expected a .json file.' }
    }
    currentFolderFiles = null
    return openJsonFile(path)
  }

  // A folder: list its top-level JSON files, skipping hidden dotfiles.
  let names: string[]
  try {
    const entries = await readdir(path, { withFileTypes: true })
    names = entries
      .filter((entry) => entry.isFile() && !entry.name.startsWith('.') && /\.json$/i.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b))
  } catch {
    return { status: 'error', fileName: basename(path), error: 'The folder could not be read.' }
  }

  if (names.length === 0) {
    await closeCurrentFile()
    currentFolderFiles = null
    return {
      status: 'error',
      fileName: basename(path),
      error: 'No JSON files found in this folder. Please choose another folder.'
    }
  }
  // A single JSON file behaves like a plain file open: no folder panel.
  if (names.length === 1) {
    currentFolderFiles = null
    return openJsonFile(join(path, names[0]))
  }
  currentFolderFiles = names.map((name) => join(path, name))
  return { status: 'folder', folderName: basename(path), files: names }
})

ipcMain.handle('json:open-file', (_event, index: unknown): Promise<OpenFileResponse> => {
  const files = currentFolderFiles
  if (!files || typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= files.length) {
    return Promise.resolve({ status: 'error', fileName: '', error: 'No folder is open.' })
  }
  return openJsonFile(files[index])
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

ipcMain.handle('json:search', (_event, query: unknown): Promise<SearchResponse> => {
  // Each new request invalidates the previous scan, so fast typing never
  // queues up stale full-file passes.
  const seq = ++searchSeq
  const isCanceled = (): boolean => seq !== searchSeq
  if (!currentFile) return Promise.resolve({ status: 'unsupported' })
  if (typeof query !== 'string') return Promise.resolve({ status: 'error', message: 'Invalid search query.' })
  if (!currentFile.searchable) return Promise.resolve({ status: 'unsupported' })
  return currentFile
    .search(query, { isCanceled })
    .then((result): SearchResponse => (result === null ? { status: 'canceled' } : { status: 'ok', ...result }))
    .catch((err: unknown): SearchResponse => ({
      status: 'error',
      message: err instanceof JsonError ? err.message : 'The search could not be completed.'
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
