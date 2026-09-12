import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AnnotationsResponse, OpenFileResponse, OpenResponse, SearchResponse } from '../shared/types'

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
      webContents: { on: vi.fn(), send: vi.fn(), setWindowOpenHandler: vi.fn() }
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
const getAnnotations = (fileIndex: number | null): Promise<AnnotationsResponse> =>
  handlers.get('json:get-annotations')!(undefined, fileIndex) as Promise<AnnotationsResponse>
const addAnnotation = (request: unknown): Promise<AnnotationsResponse> =>
  handlers.get('json:add-annotation')!(undefined, request) as Promise<AnnotationsResponse>
const removeAnnotation = (request: unknown): Promise<AnnotationsResponse> =>
  handlers.get('json:remove-annotation')!(undefined, request) as Promise<AnnotationsResponse>

async function readSidecar(folder: string, sourceName: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(folder, sourceName.replace(/\.json$/i, '') + '.annotations.json'), 'utf8'))
}

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

  it('cancels an in-flight folder search when another folder is opened', async () => {
    // The scan reads thousands of elements one await at a time, so it is
    // still running when the second, single-file folder opens and retires
    // it. The pending search must resolve as canceled — not reject with a
    // TypeError from the replaced (null) folder file list.
    const many = Array.from({ length: 2000 }, (_, i) => `{"word": "apple ${i}"}`).join(',')
    const folder = await folderFixture('search-race', { 'a.json': `[${many}]`, 'b.json': '[{"word": "apple"}]' })
    pick(folder)
    await openFolder()
    const pending = search('apple')
    const lone = await folderFixture('search-race-lone', { 'only.json': '[1]' })
    pick(lone)
    expect((await openFolder()).status).toBe('ok')
    await expect(pending).resolves.toEqual({ status: 'canceled' })
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

describe('annotations', () => {
  // Lines are numbered so annotation locations are predictable:
  // the "error" value of item 2 sits on line 6.
  const logJson = `[
  {"id": 1},
  {
    "id": 2,
    "status": "failed",
    "error": "connection refused"
  }
]`

  it('hides sidecar annotation files from the folder listing', async () => {
    const folder = await folderFixture('annotated-listing', {
      'logs.json': '[1]',
      'logs.annotations.json': '{"version":1,"sourceFile":"logs.json","annotations":[]}',
      'notes.json': '[2]'
    })
    pick(folder)
    const result = await openFolder()
    expect(result).toEqual({ status: 'folder', folderName: 'annotated-listing', files: ['logs.json', 'notes.json'] })
  })

  it('starts with no annotations for a fresh file', async () => {
    const folder = await folderFixture('annotations-fresh', { 'a.json': '[1]', 'b.json': '[2]' })
    pick(folder)
    await openFolder()
    const result = await getAnnotations(0)
    expect(result).toEqual({ status: 'ok', annotations: [] })
  })

  it('records a value annotation with its line, byte offset and snippet', async () => {
    const folder = await folderFixture('annotations-value', { 'logs.json': logJson, 'other.json': '[1]' })
    pick(folder)
    await openFolder()
    const result = await addAnnotation({ fileIndex: 0, itemIndex: 1, path: ['error'], message: 'The service never answered.' })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.annotations).toHaveLength(1)
    const [annotation] = result.annotations
    expect(annotation).toMatchObject({
      itemIndex: 1,
      path: ['error'],
      line: 6,
      snippet: '"connection refused"',
      message: 'The service never answered.'
    })
    expect(annotation.byteOffset).toBeGreaterThan(0)
    expect(annotation.id).toBeTruthy()
    expect(annotation.createdAt).toBeTruthy()

    // The sidecar sits next to the source file and holds the same data.
    const sidecar = await readSidecar(folder, 'logs.json')
    expect(sidecar).toMatchObject({ version: 1, sourceFile: 'logs.json' })
    expect((sidecar.annotations as unknown[]).length).toBe(1)
    // Loading the annotations again returns what was stored.
    expect(await getAnnotations(0)).toEqual(result)
  })

  it('locates the annotated value exactly when items start on one line', async () => {
    const folder = await folderFixture('annotations-inline', {
      'inline.json': '[{"id": 1, "msg": "boom"}, {"id": 2, "msg": "fine"}]',
      'other.json': '[1]'
    })
    pick(folder)
    await openFolder()
    const result = await addAnnotation({ fileIndex: 0, itemIndex: 0, path: ['msg'], message: '' })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    // No note was sent, so the value's own text becomes the message.
    expect(result.annotations[0]).toMatchObject({ line: 1, snippet: '"boom"', message: '"boom"' })
  })

  it('annotates a whole item without a path', async () => {
    const folder = await folderFixture('annotations-item', { 'logs.json': logJson, 'other.json': '[1]' })
    pick(folder)
    await openFolder()
    const result = await addAnnotation({
      fileIndex: 0,
      itemIndex: 1,
      path: null,
      message: 'Item 2 is not valid JSON: unexpected token.'
    })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    // The item's own start line is the finest location available, and the
    // whole element text becomes its excerpt.
    expect(result.annotations[0]).toMatchObject({ itemIndex: 1, path: null, line: 3 })
  })

  it('annotates an item that failed to parse in the viewer', async () => {
    const folder = await folderFixture('annotations-broken-item', {
      'broken.json': '[{"ok": 1}, {"broken": }]',
      'other.json': '[1]'
    })
    pick(folder)
    await openFolder()
    const opened = await openFile(0)
    expect(opened.status).toBe('ok')
    const item = await handlers.get('json:get-item')!(undefined, 1)
    expect(item).toMatchObject({ status: 'error' })
    const result = await addAnnotation({ fileIndex: 0, itemIndex: 1, path: null, message: 'Bad element in the dump.' })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.annotations[0]).toMatchObject({ itemIndex: 1, path: null, line: 1 })
  })

  it('annotates a file that failed to open, marking the error annotatable', async () => {
    const folder = await folderFixture('annotations-broken-file', { 'broken.json': '{not json' })
    pick(folder)
    const result = await openFolder()
    // A single broken file is opened directly and fails.
    expect(result).toMatchObject({ status: 'error', fileName: 'broken.json', annotatable: true })
    const saved = await addAnnotation({ fileIndex: null, itemIndex: null, path: null, message: 'Invalid JSON at line 1.' })
    expect(saved).toEqual({
      status: 'ok',
      annotations: [expect.objectContaining({ itemIndex: null, path: null, line: null, message: 'Invalid JSON at line 1.' })]
    })
  })

  it('reports errors for impossible annotation targets', async () => {
    const folder = await folderFixture('annotations-errors', { 'a.json': '[1]', 'b.json': '{"k": "v"}' })
    pick(folder)
    await openFolder()
    await openFile(0)

    // Out-of-range item.
    expect(await addAnnotation({ fileIndex: 0, itemIndex: 9, path: null, message: 'x' })).toEqual({
      status: 'error',
      message: 'The annotated item does not exist in this file.'
    })
    // Path that does not exist in the item.
    expect(await addAnnotation({ fileIndex: 0, itemIndex: 0, path: ['nope'], message: 'x' })).toEqual({
      status: 'error',
      message: 'The annotated location does not exist in this file.'
    })
    // A path inside a value-root file is fine; a bogus index on it is not.
    expect(await addAnnotation({ fileIndex: 1, itemIndex: 0, path: null, message: 'x' })).toEqual({
      status: 'error',
      message: 'The file is not a JSON array.'
    })
    // Malformed requests.
    expect((await addAnnotation(null)).status).toBe('error')
    expect((await addAnnotation({ fileIndex: 0, itemIndex: 0, path: [{}], message: 'x' })).status).toBe('error')
    expect((await addAnnotation({ fileIndex: 0, itemIndex: 0, path: null })).status).toBe('error')
    // Nothing is written when a request fails.
    expect(await getAnnotations(0)).toEqual({ status: 'ok', annotations: [] })
  })

  it('rejects annotations when no file backs the request', async () => {
    // The suite's earlier tests leave files open, so only a folder index
    // outside the opened folder proves the "nothing to annotate" path.
    const folder = await folderFixture('annotations-no-file', { 'a.json': '[1]', 'b.json': '[2]' })
    pick(folder)
    await openFolder()
    expect(await addAnnotation({ fileIndex: 5, itemIndex: 0, path: null, message: 'x' })).toEqual({
      status: 'error',
      message: 'No file is open.'
    })
    expect(await getAnnotations(5)).toEqual({ status: 'error', message: 'No file is open.' })
    expect(await removeAnnotation({ fileIndex: 9, itemIndex: 0, path: null })).toEqual({
      status: 'error',
      message: 'No file is open.'
    })
    // A negative index is not a location probe at all — the request itself
    // is malformed.
    expect(await removeAnnotation({ fileIndex: -1, itemIndex: 0, path: null })).toEqual({
      status: 'error',
      message: 'The annotation request is invalid.'
    })
  })

  it('replaces an existing annotation of the same location instead of duplicating it', async () => {
    const folder = await folderFixture('annotations-dedupe', { 'logs.json': logJson, 'other.json': '[1]' })
    pick(folder)
    await openFolder()
    await addAnnotation({ fileIndex: 0, itemIndex: 1, path: ['error'], message: 'first' })
    const second = await addAnnotation({ fileIndex: 0, itemIndex: 1, path: ['error'], message: 'second' })
    expect(second.status).toBe('ok')
    if (second.status !== 'ok') return
    expect(second.annotations).toHaveLength(1)
    expect(second.annotations[0].message).toBe('second')
  })

  it('removes an annotation by location, tolerating unknown ones', async () => {
    const folder = await folderFixture('annotations-remove', { 'logs.json': logJson, 'other.json': '[1]' })
    pick(folder)
    await openFolder()
    await addAnnotation({ fileIndex: 0, itemIndex: 1, path: ['error'], message: 'flagged' })
    const removed = await removeAnnotation({ fileIndex: 0, itemIndex: 1, path: ['error'] })
    expect(removed).toEqual({ status: 'ok', annotations: [] })
    // Removing a location that has none changes nothing.
    expect(await removeAnnotation({ fileIndex: 0, itemIndex: 1, path: ['error'] })).toEqual({
      status: 'ok',
      annotations: []
    })
    const sidecar = await readSidecar(folder, 'logs.json')
    expect(sidecar.annotations).toEqual([])
  })

  it('keeps annotations of the same file written concurrently', async () => {
    const folder = await folderFixture('annotations-race', { 'logs.json': logJson, 'other.json': '[1]' })
    pick(folder)
    await openFolder()
    const results = await Promise.all([
      addAnnotation({ fileIndex: 0, itemIndex: 0, path: ['id'], message: 'one' }),
      addAnnotation({ fileIndex: 0, itemIndex: 1, path: ['error'], message: 'two' })
    ])
    for (const result of results) expect(result.status).toBe('ok')
    const stored = await getAnnotations(0)
    expect(stored.status).toBe('ok')
    if (stored.status !== 'ok') return
    expect(stored.annotations.map((annotation) => annotation.message).sort()).toEqual(['one', 'two'])
  })

  it('annotates the single open file when no folder is open', async () => {
    const folder = await folderFixture('annotations-single', {
      'only.json': '{\n  "note": "odd value"\n}'
    })
    pick(folder)
    const result = await openFolder()
    expect(result).toMatchObject({ status: 'ok', fileName: 'only.json' })
    const saved = await addAnnotation({ fileIndex: null, itemIndex: null, path: ['note'], message: 'check this' })
    expect(saved.status).toBe('ok')
    if (saved.status !== 'ok') return
    expect(saved.annotations[0]).toMatchObject({ itemIndex: null, path: ['note'], line: 2, snippet: '"odd value"' })
    expect(await getAnnotations(null)).toEqual(saved)
  })
})
