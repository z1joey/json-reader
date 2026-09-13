import { describe, expect, it } from 'vitest'
import {
  annotationFilePathFor,
  byteOffsetAt,
  emptyAnnotationList,
  excerpt,
  isAnnotationFileName,
  lineAt,
  locateValue,
  newAnnotation,
  parseAnnotationList,
  queueSidecarWrite,
  readAnnotationList,
  withAnnotation,
  withoutAnnotation,
  writeAnnotationList
} from './annotations'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Annotation } from '../shared/types'

describe('sidecar file names', () => {
  it('sits next to the source file with an .annotations.json suffix', () => {
    expect(annotationFilePathFor('/data/logs.json')).toBe('/data/logs.annotations.json')
    expect(annotationFilePathFor('/data/logs.JSON')).toBe('/data/logs.annotations.json')
    expect(annotationFilePathFor('/data/no-extension')).toBe('/data/no-extension.annotations.json')
  })

  it('recognizes its own sidecar files, including uppercase ones', () => {
    expect(isAnnotationFileName('logs.annotations.json')).toBe(true)
    expect(isAnnotationFileName('LOGS.ANNOTATIONS.JSON')).toBe(true)
    expect(isAnnotationFileName('logs.json')).toBe(false)
    expect(isAnnotationFileName('annotations.json')).toBe(false)
  })
})

describe('locateValue', () => {
  const doc = `{
    "word": "apple",
    "empty": "",
    "quoted": "he said \\"hi\\" [not an array] {nor an object}",
    "count": 42,
    "ratio": -1.5e3,
    "ok": true,
    "missing": null,
    "tags": ["red", "green", {"shade": "dark red"}],
    "nested": {"deep": [{"list": ["target"]}]},
    "tricky key": "found",
    "\\u0041": "unescaped A key"
  }`

  it('locates values at top-level object keys', () => {
    expect(locateValue(doc, ['word'])).toEqual({ start: doc.indexOf('"apple"'), end: doc.indexOf('"apple"') + 7 })
    expect(locateValue(doc, ['count'])).toEqual({ start: doc.indexOf('42'), end: doc.indexOf('42') + 2 })
    expect(locateValue(doc, ['ok'])).toEqual({ start: doc.indexOf('true'), end: doc.indexOf('true') + 4 })
    expect(locateValue(doc, ['missing'])).toEqual({ start: doc.indexOf('null'), end: doc.indexOf('null') + 4 })
  })

  it('locates nested values through objects and arrays', () => {
    const target = doc.indexOf('"target"')
    expect(locateValue(doc, ['nested', 'deep', 0, 'list', 0])).toEqual({ start: target, end: target + 8 })
    const shade = doc.indexOf('"dark red"')
    expect(locateValue(doc, ['tags', 2, 'shade'])).toEqual({ start: shade, end: shade + 10 })
    expect(locateValue(doc, ['tags', 0])).toEqual({ start: doc.indexOf('"red"'), end: doc.indexOf('"red"') + 5 })
  })

  it('locates containers as a whole', () => {
    const range = locateValue(doc, ['tags'])
    expect(range).not.toBeNull()
    if (range) expect(JSON.parse(doc.slice(range.start, range.end))).toEqual(['red', 'green', { shade: 'dark red' }])
  })

  it('addresses the whole document with an empty path', () => {
    const range = locateValue(doc, [])
    expect(range).toEqual({ start: doc.indexOf('{'), end: doc.length })
  })

  it('matches string keys containing brackets, braces and quotes', () => {
    const range = locateValue(doc, ['quoted'])
    expect(range?.start).toBe(doc.indexOf('"he said'))
    if (range) expect(JSON.parse(doc.slice(range.start, range.end))).toContain('[not an array]')
  })

  it('matches keys that are escaped in the raw text', () => {
    const unescaped = doc.indexOf('"unescaped A key"')
    expect(locateValue(doc, ['A'])).toEqual({ start: unescaped, end: unescaped + 17 })
    expect(locateValue(doc, ['tricky key'])?.start).toBe(doc.indexOf('"found"'))
  })

  it('locates values inside string-heavy siblings without losing its place', () => {
    const tricky = `{"a": "} , \\" , { , [ , :", "b": [ "]}]", {"c": 7}] }`
    expect(locateValue(tricky, ['b', 1, 'c'])).toEqual({ start: tricky.indexOf('7'), end: tricky.indexOf('7') + 1 })
    expect(locateValue(tricky, ['a'])?.start).toBe(tricky.indexOf('"} , '))
  })

  it('returns null for paths that do not exist', () => {
    expect(locateValue(doc, ['nope'])).toBeNull()
    expect(locateValue(doc, ['tags', 9])).toBeNull()
    expect(locateValue(doc, ['word', 'deeper'])).toBeNull()
    expect(locateValue(doc, ['tags', 'red'])).toBeNull()
    expect(locateValue(doc, ['nested', 0])).toBeNull()
    expect(locateValue(doc, [])).not.toBeNull()
  })

  it('returns null for malformed text instead of throwing', () => {
    expect(locateValue('{"a": ', ['a'])).toBeNull()
    expect(locateValue('[1, 2', [0])).toEqual({ start: 1, end: 2 })
    expect(locateValue('[1,]', [1])).toBeNull()
    expect(locateValue('', [])).toBeNull()
  })
})

describe('location math', () => {
  it('counts lines from character offsets', () => {
    expect(lineAt('one\ntwo\nthree', 0)).toBe(1)
    expect(lineAt('one\ntwo\nthree', 4)).toBe(2)
    expect(lineAt('one\ntwo\nthree', 8)).toBe(3)
    expect(lineAt('one\ntwo\nthree', 13)).toBe(3)
    expect(lineAt('\n\n', 2)).toBe(3)
  })

  it('counts UTF-8 bytes, not characters', () => {
    const text = '"🍎🍎" tail'
    const tail = text.indexOf(' tail')
    expect(byteOffsetAt(text, tail)).toBe(2 + 4 + 4)
  })

  it('collapses and ellipsizes excerpts', () => {
    expect(excerpt('  "a\n  multiline\nvalue"  ')).toBe('"a multiline value"')
    const long = 'x'.repeat(500)
    const cut = excerpt(long)
    expect(cut.length).toBe(201)
    expect(cut.endsWith('…')).toBe(true)
  })
})

describe('sidecar lists', () => {
  const sample: Annotation = {
    id: 'a-1',
    itemIndex: 3,
    path: ['error'],
    line: 12,
    byteOffset: 340,
    snippet: '"connection refused"',
    message: 'The service never came up.',
    createdAt: '2026-09-13T10:00:00.000Z'
  }

  it('adds annotations and replaces one of the same location', () => {
    const fresh = emptyAnnotationList('logs.json')
    const once = withAnnotation(fresh, sample)
    expect(once.annotations).toHaveLength(1)
    expect(once.updatedAt >= once.createdAt).toBe(true)

    const twin = { ...sample, id: 'a-2', message: 'Second look.' }
    const twice = withAnnotation(once, twin)
    expect(twice.annotations).toHaveLength(1)
    expect(twice.annotations[0].id).toBe('a-2')
  })

  it('keeps annotations of other locations when replacing', () => {
    const other = withAnnotation(emptyAnnotationList('logs.json'), { ...sample, itemIndex: 9 })
    const both = withAnnotation(other, sample)
    expect(both.annotations).toHaveLength(2)
  })

  it('removes by id and ignores unknown ids', () => {
    const one = withAnnotation(emptyAnnotationList('logs.json'), sample)
    expect(withoutAnnotation(one, 'missing').annotations).toHaveLength(1)
    expect(withoutAnnotation(one, 'a-1').annotations).toHaveLength(0)
  })

  it('round-trips through a file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'json-reader-annotations-'))
    try {
      const sidecar = join(dir, 'logs.annotations.json')
      const written = withAnnotation(emptyAnnotationList('logs.json'), sample)
      await writeAnnotationList(sidecar, written)
      expect(await readAnnotationList(sidecar, 'logs.json')).toEqual(written)
      expect((await readFile(sidecar, 'utf8')).endsWith('\n')).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('starts fresh when the sidecar is missing or damaged', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'json-reader-annotations-'))
    try {
      const sidecar = join(dir, 'logs.annotations.json')
      const fresh = await readAnnotationList(sidecar, 'logs.json')
      expect(fresh.sourceFile).toBe('logs.json')
      expect(fresh.annotations).toEqual([])
      await writeFile(sidecar, '{not json', 'utf8')
      const recovered = await readAnnotationList(sidecar, 'logs.json')
      expect(recovered.sourceFile).toBe('logs.json')
      expect(recovered.annotations).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('parses valid sidecars and drops invalid entries', () => {
    const good = JSON.stringify(withAnnotation(emptyAnnotationList('logs.json'), sample), null, 2)
    expect(parseAnnotationList(good)?.annotations).toHaveLength(1)

    const damaged = JSON.stringify({
      version: 1,
      sourceFile: 'logs.json',
      annotations: [
        sample,
        { id: 'bad', itemIndex: 'three', path: null, line: 1, byteOffset: 1, snippet: '', message: '', createdAt: '' },
        { id: '', itemIndex: 0, path: null, line: 1, byteOffset: 1, snippet: '', message: '', createdAt: '' },
        'an annotation, sort of'
      ]
    })
    const parsed = parseAnnotationList(damaged)
    expect(parsed?.annotations.map((a) => a.id)).toEqual(['a-1'])

    expect(parseAnnotationList('["not an object"]')).toBeNull()
    expect(parseAnnotationList('{"version": 2, "sourceFile": "x", "annotations": []}')).toBeNull()
    expect(parseAnnotationList('null')).toBeNull()
    expect(parseAnnotationList('{')).toBeNull()
  })

  it('accepts item-level annotations without a path', () => {
    const itemLevel = newAnnotation({
      itemIndex: null,
      path: null,
      line: null,
      byteOffset: null,
      snippet: null,
      message: 'Broken file'
    })
    expect(itemLevel.id).toBeTruthy()
    expect(itemLevel.createdAt).toBeTruthy()
    const list = withAnnotation(emptyAnnotationList('logs.json'), itemLevel)
    expect(list.annotations).toHaveLength(1)
  })
})

describe('sidecar write queue', () => {
  it('runs queued writes for one path in submission order', async () => {
    const order: number[] = []
    const first = queueSidecarWrite('sidecar', async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      order.push(1)
    })
    const second = queueSidecarWrite('sidecar', async () => {
      order.push(2)
    })
    await Promise.all([first, second])
    expect(order).toEqual([1, 2])
  })

  it('keeps the queue alive when a write fails and isolates other paths', async () => {
    await expect(queueSidecarWrite('sidecar', async () => { throw new Error('disk full') })).rejects.toThrow('disk full')
    await expect(queueSidecarWrite('sidecar', async () => 'recovered')).resolves.toBe('recovered')
    await expect(queueSidecarWrite('other', async () => 'unaffected')).resolves.toBe('unaffected')
  })
})
