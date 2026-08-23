import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme } from 'electron'
import { readdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { JsonFile, JsonError, searchText } from './jsonFile'
import type { ItemResponse, OpenFileResponse, OpenResponse, SearchHit, SearchResponse } from '../shared/types'

let mainWindow: BrowserWindow | null = null
let currentFile: JsonFile | null = null
let currentFileName: string | null = null
let currentFolderFiles: string[] | null = null
let searchSeq = 0

const FOLDER_SEARCH_LIMIT = 10

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
  const requestOpenFolder = (): void => {
    mainWindow?.webContents.send('open-folder-requested')
  }

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open Folder…', accelerator: 'CmdOrCtrl+O', click: requestOpenFolder },
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
    currentFileName = fileName
    return { status: 'ok', fileName, root: file.root }
  } catch (err) {
    currentFile = null
    currentFileName = null
    const message = err instanceof JsonError ? err.message : 'The file could not be read.'
    return { status: 'error', fileName, error: message }
  }
}

/**
 * Opens a folder whose top-level JSON files become the current folder.
 * A single JSON file is opened directly; multiple files get a sidebar.
 */
async function openFolderPath(path: string): Promise<OpenResponse> {
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
    currentFileName = null
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
}

async function showAndOpenFolder(win: BrowserWindow): Promise<OpenResponse> {
  const picked = await dialog.showOpenDialog(win, {
    title: 'Open folder',
    properties: ['openDirectory']
  })
  if (picked.canceled || picked.filePaths.length === 0) return { status: 'canceled' }
  return openFolderPath(picked.filePaths[0])
}

ipcMain.handle('json:open-folder', (): Promise<OpenResponse> => {
  const win = mainWindow
  if (!win) return Promise.resolve({ status: 'canceled' })
  return showAndOpenFolder(win)
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

async function searchCurrentFile(query: string, isCanceled: () => boolean): Promise<SearchResponse> {
  if (!currentFile || !currentFile.searchable) return { status: 'unsupported' }
  try {
    const result = await currentFile.search(query, { isCanceled })
    if (result === null) return { status: 'canceled' }
    const fileName = currentFileName ?? ''
    return {
      status: 'ok',
      hits: result.hits.map((hit) => ({ ...hit, fileIndex: 0, fileName })),
      moreAvailable: result.moreAvailable
    }
  } catch (err) {
    return {
      status: 'error',
      message: err instanceof JsonError ? err.message : 'The search could not be completed.'
    }
  }
}

async function searchFolder(query: string, isCanceled: () => boolean): Promise<SearchResponse> {
  if (!currentFolderFiles || currentFolderFiles.length === 0) return { status: 'unsupported' }
  const hits: SearchHit[] = []
  let moreAvailable = false

  const addHit = (hit: SearchHit): void => {
    let slot = hits.length
    while (slot > 0 && hits[slot - 1].tier > hit.tier) slot--
    if (hits.length < FOLDER_SEARCH_LIMIT) {
      hits.splice(slot, 0, hit)
    } else if (slot < FOLDER_SEARCH_LIMIT) {
      hits.splice(slot, 0, hit)
      hits.pop()
      moreAvailable = true
    } else {
      moreAvailable = true
    }
  }

  for (let fileIndex = 0; fileIndex < currentFolderFiles.length; fileIndex++) {
    if (isCanceled()) return { status: 'canceled' }
    const path = currentFolderFiles[fileIndex]
    const fileName = basename(path)

    let file: JsonFile | null = null
    try {
      file = await JsonFile.open(path)
    } catch {
      file = null
    }

    try {
      if (file?.searchable) {
        const result = await file.search(query, { isCanceled })
        if (result === null) return { status: 'canceled' }
        for (const hit of result.hits) {
          addHit({ ...hit, fileIndex, fileName })
        }
      } else {
        const text = await readFile(path, 'utf8')
        const found = searchText(text, query)
        if (found) addHit({ ...found, fileIndex, fileName, index: 0 })
      }
    } catch {
      // Skip files that cannot be searched (unreadable, malformed, etc.).
    } finally {
      await file?.close().catch(() => {})
    }
  }

  return { status: 'ok', hits, moreAvailable }
}

ipcMain.handle('json:search', (_event, query: unknown): Promise<SearchResponse> => {
  // Each new request invalidates the previous scan, so fast typing never
  // queues up stale full-file passes.
  const seq = ++searchSeq
  const isCanceled = (): boolean => seq !== searchSeq
  if (typeof query !== 'string') return Promise.resolve({ status: 'error', message: 'Invalid search query.' })
  const search = currentFolderFiles && currentFolderFiles.length > 0
    ? searchFolder(query, isCanceled)
    : searchCurrentFile(query, isCanceled)
  return search
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
