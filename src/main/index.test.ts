import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OpenFileResponse, OpenResponse } from '../shared/types'

// Electron is replaced wholesale: only the pieces index.ts touches exist,
// and the dialog is driven by each test. The file system stays real, so
// folder scanning and JSON opening run against actual temp directories.
const { appMock, browserWindowMock, dialogMock, ipcMainMock, menuMock } = vi.hoisted(() => ({
  appMock: { whenReady: vi.fn(() => Promise.resolve()), on: vi.fn(), quit: vi.fn() },
  // A `function` implementation so `new BrowserWindow(...)` works and
  // returns this window object (constructors keep an explicit return value).
  browserWindowMock: vi.fn(function () {
    return {
      on: vi.fn(),
      show: vi.fn(),
      loadFile: vi.fn(),
      loadURL: vi.fn(),
      webContents: { on: vi.fn(), send: vi.fn() }
    }
  }),
  dialogMock: { showOpenDialog: vi.fn() },
  ipcMainMock: { handle: vi.fn() },
  menuMock: { setApplicationMenu: vi.fn(), buildFromTemplate: vi.fn() }
}))

vi.mock('electron', () => ({
  app: appMock,
  BrowserWindow: browserWindowMock,
  dialog: dialogMock,
  ipcMain: ipcMainMock,
  Menu: menuMock,
  nativeTheme: {}
}))

let dir: string
const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()

beforeAll(async () => {
  vi.stubGlobal('__dirname', process.cwd())
  dir = await mkdtemp(join(tmpdir(), 'json-reader-main-'))
  await import('./index')
  // The module wires the menu and the window once app.whenReady() settles.
  await vi.waitFor(() => expect(browserWindowMock).toHaveBeenCalled())
  for (const call of ipcMainMock.handle.mock.calls) {
    handlers.set(call[0] as string, call[1] as (...args: unknown[]) => Promise<unknown>)
  }
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
  vi.unstubAllGlobals()
})

beforeEach(() => {
  dialogMock.showOpenDialog.mockReset()
})

async function fixture(name: string, content: string): Promise<string> {
  const path = join(dir, name)
  await writeFile(path, content, 'utf8')
  return path
}

async function folderFixture(name: string, files: Record<string, string>): Promise<string> {
  const folder = join(dir, name)
  await mkdir(folder)
  for (const [file, content] of Object.entries(files)) {
    await writeFile(join(folder, file), content, 'utf8')
  }
  return folder
}

function pick(...filePaths: string[]): void {
  dialogMock.showOpenDialog.mockResolvedValue({ canceled: false, filePaths })
}

const open = (): Promise<OpenResponse> => handlers.get('json:open')!() as Promise<OpenResponse>
const openFolder = (): Promise<OpenResponse> => handlers.get('json:open-folder')!() as Promise<OpenResponse>
const openFile = (index: number): Promise<OpenFileResponse> =>
  handlers.get('json:open-file')!(undefined, index) as Promise<OpenFileResponse>

describe('open dialogs', () => {
  it('keeps the Open JSON dialog a file selector so single files stay openable on every platform', async () => {
    const path = await fixture('single.json', '{"a": 1}')
    pick(path)
    const result = await open()
    // On Windows and Linux a dialog cannot select files and folders at once,
    // so 'openDirectory' must stay out of the file dialog's properties.
    expect(dialogMock.showOpenDialog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ properties: ['openFile'] })
    )
    expect(result).toEqual({ status: 'ok', fileName: 'single.json', root: { type: 'value', value: { a: 1 } } })
  })

  it('opens a folder through a separate directory-only dialog', async () => {
    const folder = await folderFixture('multi', { 'b.json': '[2]', 'a.json': '[1]' })
    pick(folder)
    const result = await openFolder()
    expect(dialogMock.showOpenDialog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ properties: ['openDirectory'] })
    )
    expect(result).toEqual({ status: 'folder', folderName: 'multi', files: ['a.json', 'b.json'] })
  })

  it('suggests choosing another folder when it contains no JSON files', async () => {
    const folder = await folderFixture('empty', { 'readme.txt': 'nothing here' })
    pick(folder)
    const result = await openFolder()
    expect(result).toEqual({
      status: 'error',
      fileName: 'empty',
      error: 'No JSON files found in this folder. Please choose another folder.'
    })
  })

  it('opens the only JSON file of a folder directly, without a folder panel', async () => {
    const folder = await folderFixture('lone', { 'only.json': '[1, 2]' })
    pick(folder)
    const result = await openFolder()
    expect(result).toEqual({ status: 'ok', fileName: 'only.json', root: { type: 'array', count: 2 } })
    // No folder was recorded, so index-based opening is unavailable.
    expect(await openFile(0)).toEqual({ status: 'error', fileName: '', error: 'No folder is open.' })
  })

  it('skips hidden dotfiles when listing the files of a folder', async () => {
    const folder = await folderFixture('dotted', { '.hidden.json': '[]', 'a.json': '[]', 'b.json': '[]' })
    pick(folder)
    const result = await openFolder()
    expect(result).toEqual({ status: 'folder', folderName: 'dotted', files: ['a.json', 'b.json'] })
  })

  it('loads a listed folder file by index', async () => {
    const folder = await folderFixture('indexed', { 'a.json': '{"x": 1}', 'b.json': '{"y": 2}' })
    pick(folder)
    await openFolder()
    expect(await openFile(1)).toEqual({
      status: 'ok',
      fileName: 'b.json',
      root: { type: 'value', value: { y: 2 } }
    })
  })

  it('rejects a non-JSON file picked in the file dialog', async () => {
    const path = await fixture('notes.txt', 'plain text')
    pick(path)
    const result = await open()
    expect(result).toEqual({
      status: 'error',
      fileName: 'notes.txt',
      error: 'Unsupported file: expected a .json file.'
    })
  })

  it('reports a canceled dialog without changing anything', async () => {
    dialogMock.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    expect(await open()).toEqual({ status: 'canceled' })
    expect(await openFolder()).toEqual({ status: 'canceled' })
  })

  it('lists Open JSON and Open Folder as separate menu items', () => {
    type Item = { label?: string; submenu?: Item[] }
    const template = menuMock.buildFromTemplate.mock.calls[0][0] as Item[]
    const file = template.find((item) => item.label === 'File')
    const labels = (file?.submenu ?? []).map((item) => item.label)
    expect(labels).toContain('Open JSON…')
    expect(labels).toContain('Open Folder…')
  })
})
