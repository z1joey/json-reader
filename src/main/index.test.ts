import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OpenFileResponse, OpenResponse, SearchResponse } from '../shared/types'

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

const openFolder = (): Promise<OpenResponse> => handlers.get('json:open-folder')!() as Promise<OpenResponse>
const openFile = (index: number): Promise<OpenFileResponse> =>
  handlers.get('json:open-file')!(undefined, index) as Promise<OpenFileResponse>
const search = (query: string): Promise<SearchResponse> =>
  handlers.get('json:search')!(undefined, query) as Promise<SearchResponse>

describe('open folder', () => {
  it('only registers the folder-opening dialog flow', () => {
    expect(handlers.has('json:open-folder')).toBe(true)
    expect(handlers.has('json:open')).toBe(false)
  })

  it('opens a folder through a directory-only dialog', async () => {
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

  it('reports a canceled dialog without changing anything', async () => {
    dialogMock.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    expect(await openFolder()).toEqual({ status: 'canceled' })
  })

  it('lists Open Folder as the only open command in the menu', () => {
    type Item = { label?: string; submenu?: Item[] }
    const template = menuMock.buildFromTemplate.mock.calls[0][0] as Item[]
    const file = template.find((item) => item.label === 'File')
    const labels = (file?.submenu ?? []).map((item) => item.label)
    expect(labels).toContain('Open Folder…')
    expect(labels).not.toContain('Open JSON…')
  })

  it('searches across all JSON files in the opened folder', async () => {
    const folder = await folderFixture('search-folder', {
      'a.json': '[{"word": "apple"}]',
      'b.json': '[{"word": "banana"}]',
      'c.json': '{"note": "apple pie"}'
    })
    pick(folder)
    await openFolder()
    const result = await search('apple')
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.hits.length).toBeGreaterThanOrEqual(2)
    const files = result.hits.map((hit) => hit.fileName)
    expect(files).toContain('a.json')
    expect(files).toContain('c.json')
    for (const hit of result.hits) {
      expect(hit.fileIndex).toBeGreaterThanOrEqual(0)
      expect(hit.fileName).toBeTruthy()
    }
  })

  it('includes array-item hits from another file with its file identity', async () => {
    const folder = await folderFixture('search-array', {
      'a.json': '[{"word": "one"}]',
      'b.json': '[{"word": "apple"}, {"word": "apple pie"}]'
    })
    pick(folder)
    await openFolder()
    const result = await search('apple')
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    const bHits = result.hits.filter((hit) => hit.fileName === 'b.json')
    expect(bHits.length).toBeGreaterThan(0)
    expect(bHits[0].fileIndex).toBe(1)
  })

  it('reports more folder matches when a single file exceeds the hit limit', async () => {
    const many = Array.from({ length: 15 }, () => '{"word": "apple"}').join(',')
    const folder = await folderFixture('search-more', {
      'many.json': `[${many}]`,
      'none.json': '[{"word": "banana"}]'
    })
    pick(folder)
    await openFolder()
    const result = await search('apple')
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    // 15 matches exist but the folder cap shows ten; the file-level flag
    // must surface so the "refine your search" hint appears.
    expect(result.hits.length).toBe(10)
    expect(result.moreAvailable).toBe(true)
  })

  // Unlinking a file with an open handle only works on POSIX; on Windows the
  // delete itself fails, so these cache-reuse probes cannot run there.
  it.skipIf(process.platform === 'win32')('keeps analyzed array files warm across folder searches', async () => {
    const folder = await folderFixture('search-warm-array', {
      'a.json': '[{"word": "apple"}, {"word": "apple pie"}]',
      'b.json': '[{"word": "banana"}]'
    })
    pick(folder)
    await openFolder()
    expect((await search('apple')).status).toBe('ok')
    // Deleting the file proves the second query does not reopen it: the
    // cached entry keeps serving from its still-open handle.
    await rm(join(folder, 'a.json'))
    const second = await search('apple')
    expect(second.status).toBe('ok')
    if (second.status !== 'ok') return
    expect(second.hits.map((hit) => hit.fileName)).toContain('a.json')
  })

  it.skipIf(process.platform === 'win32')('caches non-array file text across folder searches', async () => {
    const folder = await folderFixture('search-warm-text', {
      'c.json': '{"note": "apple pie"}',
      'd.json': '[{"word": "banana"}]'
    })
    pick(folder)
    await openFolder()
    const first = await search('apple')
    expect(first.status).toBe('ok')
    if (first.status !== 'ok') return
    expect(first.hits.some((hit) => hit.fileName === 'c.json')).toBe(true)
    // Deleting the file proves the second query does not reread it: the
    // cached raw text keeps serving the hit.
    await rm(join(folder, 'c.json'))
    const second = await search('apple')
    expect(second.status).toBe('ok')
    if (second.status !== 'ok') return
    expect(second.hits.some((hit) => hit.fileName === 'c.json')).toBe(true)
  })
})
