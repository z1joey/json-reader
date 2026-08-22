import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonFile, JsonError } from './jsonFile'

let dir: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'json-reader-'))
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function fixture(name: string, content: string): Promise<string> {
  const path = join(dir, name)
  await writeFile(path, content, 'utf8')
  return path
}

describe('array roots', () => {
  it('indexes an array of objects and parses items on demand', async () => {
    const path = await fixture(
      'objects.json',
      `[\n  {"id": 1, "word": "apple"},\n  {"id": 2, "word": "fig"}\n]`
    )
    const file = await JsonFile.open(path)
    expect(file.root).toEqual({ type: 'array', count: 2 })
    expect(await file.item(0)).toEqual({ id: 1, word: 'apple' })
    expect(await file.item(1)).toEqual({ id: 2, word: 'fig' })
    await file.close()
  })

  it('indexes an array of primitives', async () => {
    const path = await fixture('primitives.json', `["a", 1, true, null, -2.5e3, 0]`)
    const file = await JsonFile.open(path)
    expect(file.root).toEqual({ type: 'array', count: 6 })
    expect(await file.item(0)).toBe('a')
    expect(await file.item(1)).toBe(1)
    expect(await file.item(2)).toBe(true)
    expect(await file.item(3)).toBe(null)
    expect(await file.item(4)).toBe(-2500)
    expect(await file.item(5)).toBe(0)
    await file.close()
  })

  it('indexes nested containers and strings containing brackets', async () => {
    const path = await fixture('nested.json', `[{"a": "}]{[", "b": [1, {"c": "["}]}, ["x"]]`)
    const file = await JsonFile.open(path)
    expect(file.root).toEqual({ type: 'array', count: 2 })
    expect(await file.item(0)).toEqual({ a: '}]{[', b: [1, { c: '[' }] })
    expect(await file.item(1)).toEqual(['x'])
    await file.close()
  })

  it('reports count 0 for an empty array', async () => {
    const path = await fixture('empty-array.json', '[]')
    const file = await JsonFile.open(path)
    expect(file.root).toEqual({ type: 'array', count: 0 })
    await file.close()
  })

  it('handles escaped quotes inside strings', async () => {
    // JSON.stringify writes the escapes into the file: ["say \"hi\"","back\\slash"]
    const path = await fixture('escapes.json', JSON.stringify(['say "hi"', 'back\\slash']))
    const file = await JsonFile.open(path)
    expect(file.root).toEqual({ type: 'array', count: 2 })
    expect(await file.item(0)).toBe('say "hi"')
    expect(await file.item(1)).toBe('back\\slash')
    await file.close()
  })

  it('handles a leading BOM', async () => {
    const path = await fixture('bom.json', '\uFEFF[{"a": 1}]')
    const file = await JsonFile.open(path)
    expect(file.root).toEqual({ type: 'array', count: 1 })
    expect(await file.item(0)).toEqual({ a: 1 })
    await file.close()
  })

  it('keeps correct offsets when elements span chunk boundaries and multibyte characters', async () => {
    const emoji = '\u{1F34E}' // apple emoji, 4 UTF-8 bytes
    const path = await fixture('chunks.json', `[\n  {"word": "${emoji}", "note": "${emoji.repeat(3)} tail"},\n  {"id": 2}\n]`)
    const file = await JsonFile.open(path, { chunkSize: 9 })
    expect(file.root).toEqual({ type: 'array', count: 2 })
    expect(await file.item(0)).toEqual({ word: emoji, note: `${emoji.repeat(3)} tail` })
    expect(await file.item(1)).toEqual({ id: 2 })
    await file.close()
  })

  it('rejects out-of-range item indexes', async () => {
    const path = await fixture('range.json', '[1, 2, 3]')
    const file = await JsonFile.open(path)
    await expect(file.item(-1)).rejects.toThrow()
    await expect(file.item(3)).rejects.toThrow()
    await file.close()
  })

  it('indexes a large array without parsing every element up front', async () => {
    const count = 50_000
    const items = Array.from(
      { length: count },
      (_, i) => `  {"id": ${i}, "word": "word${i}", "definition": "A reasonably long definition line for word number ${i}."}`
    )
    const path = await fixture('large.json', `[\n${items.join(',\n')}\n]`)
    const started = Date.now()
    const file = await JsonFile.open(path)
    const elapsed = Date.now() - started
    expect(file.root).toEqual({ type: 'array', count })
    expect(await file.item(0)).toEqual({ id: 0, word: 'word0', definition: expect.any(String) })
    expect(((await file.item(count - 1)) as { id: number }).id).toBe(count - 1)
    expect(((await file.item(25_000)) as { word: string }).word).toBe('word25000')
    await file.close()
    // Loose guard against pathological rescanning: indexing 50k items must be quick.
    expect(elapsed).toBeLessThan(10_000)
  })
})

describe('search', () => {
  it('finds matches and ranks exact values above prefixes above substrings', async () => {
    const path = await fixture(
      'search-rank.json',
      JSON.stringify([
        { word: 'fig' },
        { word: 'apple pie' },
        { note: 'I like apples a lot' },
        { word: 'apple' }
      ])
    )
    const file = await JsonFile.open(path)
    const result = await file.search('apple')
    expect(result).toEqual({
      hits: [
        { index: 3, tier: 1, field: 'word', snippet: expect.any(String), matchStart: expect.any(Number), matchLength: 5 },
        { index: 1, tier: 2, field: 'word', snippet: expect.any(String), matchStart: expect.any(Number), matchLength: 5 },
        { index: 2, tier: 3, field: 'note', snippet: expect.any(String), matchStart: expect.any(Number), matchLength: 5 }
      ],
      moreAvailable: false
    })
    if (result === null) throw new Error('search unexpectedly canceled')
    for (const hit of result.hits) {
      expect(hit.snippet.slice(hit.matchStart, hit.matchStart + hit.matchLength).toLowerCase()).toBe('apple')
    }
    await file.close()
  })

  it('matches case-insensitively', async () => {
    const file = await JsonFile.open(await fixture('search-case.json', '[{"w":"Apple"},{"w":"APPLE"},{"w":"apples"}]'))
    const result = (await file.search('apple')) as { hits: Array<{ index: number; tier: number }> }
    expect(result.hits.map((h) => h.index)).toEqual([0, 1, 2])
    expect(result.hits.map((h) => h.tier)).toEqual([1, 1, 2])
    await file.close()
  })

  it('respects the limit of ten hits and reports more availability', async () => {
    const items = Array.from({ length: 25 }, (_, i) => ({ id: i, text: `contains apple number ${i}` }))
    const file = await JsonFile.open(await fixture('search-limit.json', JSON.stringify(items)))
    const result = (await file.search('apple')) as { hits: unknown[]; moreAvailable: boolean }
    expect(result.hits).toHaveLength(10)
    expect(result.moreAvailable).toBe(true)
    await file.close()
  })

  it('stops early once ten exact matches fill the list', async () => {
    const items = Array.from({ length: 40 }, (_, i) => ({ w: i < 15 ? 'apple' : `word${i}` }))
    const file = await JsonFile.open(await fixture('search-early.json', JSON.stringify(items)))
    const result = (await file.search('apple')) as { hits: Array<{ tier: number }>; moreAvailable: boolean }
    expect(result.hits).toHaveLength(10)
    expect(result.hits.every((h) => h.tier === 1)).toBe(true)
    expect(result.moreAvailable).toBe(true)
    await file.close()
  })

  it('returns snippets around the match and detects the enclosing field', async () => {
    const long = 'lorem ipsum '.repeat(20) + 'apple pie recipe ' + 'dolor sit. '.repeat(20)
    const file = await JsonFile.open(await fixture('search-snippet.json', JSON.stringify([{ body: long }])))
    const result = (await file.search('pie')) as { hits: Array<{ snippet: string; field: string }> }
    expect(result.hits[0].field).toBe('body')
    expect(result.hits[0].snippet).toContain('…')
    expect(result.hits[0].snippet).toContain('apple pie')
    expect(result.hits[0].snippet.length).toBeLessThan(120)
    await file.close()
  })

  it('handles multibyte content in matching and snippets', async () => {
    const emoji = '\u{1F34E}'
    const file = await JsonFile.open(
      await fixture('search-utf8.json', JSON.stringify([{ note: `${emoji} is a red apple ${emoji}` }, { n: 1 }]))
    )
    const result = (await file.search(emoji)) as { hits: Array<{ index: number; snippet: string }> }
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0].index).toBe(0)
    expect(result.hits[0].snippet).toContain(emoji)
    expect(result.hits[0].snippet).not.toContain('\uFFFD')
    await file.close()
  })

  it('reports match offsets that line up with the query inside the snippet', async () => {
    const file = await JsonFile.open(await fixture('search-offset.json', JSON.stringify([{ body: 'a tiny apple sits here' }])))
    const result = await file.search('Apple')
    expect(result).toEqual({
      hits: [
        {
          index: 0,
          tier: 3,
          field: 'body',
          snippet: '{"body":"a tiny apple sits here"}',
          matchStart: 16,
          matchLength: 5
        }
      ],
      moreAvailable: false
    })
    await file.close()
  })

  it('narrows results when the query extends the previous one', async () => {
    const file = await JsonFile.open(
      await fixture('search-narrow.json', JSON.stringify([{ w: 'app' }, { w: 'apple' }, { w: 'application' }]))
    )
    const first = (await file.search('app')) as { hits: Array<{ index: number; tier: number }> }
    expect(first.hits.map((h) => h.index)).toEqual([0, 1, 2])
    expect(first.hits.map((h) => h.tier)).toEqual([1, 2, 2])

    const second = (await file.search('appl')) as { hits: Array<{ index: number }> }
    expect(second.hits.map((h) => h.index)).toEqual([1, 2])

    const third = (await file.search('apple')) as { hits: Array<{ index: number; tier: number }> }
    expect(third.hits.map((h) => h.index)).toEqual([1])
    expect(third.hits[0].tier).toBe(1)
    await file.close()
  })

  it('classifies matches in pretty-printed JSON', async () => {
    const path = await fixture('search-pretty.json', '[\n  {\n    "word": "fig"\n  },\n  {\n    "word": "apple"\n  }\n]')
    const file = await JsonFile.open(path)
    const result = (await file.search('apple')) as { hits: Array<{ index: number; tier: number; field: string }> }
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0].index).toBe(1)
    expect(result.hits[0].tier).toBe(1)
    expect(result.hits[0].field).toBe('word')
    await file.close()
  })

  it('keeps moreAvailable truthful on the memo fast path', async () => {
    // Exactly ten matches: the full scan says no more are available and a
    // narrowing query must not flip that to true.
    const items = Array.from({ length: 10 }, (_, i) => ({ w: `apples ${i}` }))
    const file = await JsonFile.open(await fixture('search-memo-exact.json', JSON.stringify(items)))
    const first = (await file.search('apple')) as { moreAvailable: boolean }
    expect(first.moreAvailable).toBe(false)
    const second = (await file.search('apples')) as { hits: unknown[]; moreAvailable: boolean }
    expect(second.hits).toHaveLength(10)
    expect(second.moreAvailable).toBe(false)
    await file.close()

    // More than ten matches: narrowing keeps reporting more available.
    const many = Array.from({ length: 12 }, (_, i) => ({ w: `apples ${i}` }))
    const file2 = await JsonFile.open(await fixture('search-memo-more.json', JSON.stringify(many)))
    const third = (await file2.search('apples')) as { moreAvailable: boolean }
    expect(third.moreAvailable).toBe(true)
    const fourth = (await file2.search('apples 1')) as { hits: Array<{ index: number }>; moreAvailable: boolean }
    expect(fourth.hits.map((h) => h.index)).toEqual([1, 10, 11])
    expect(fourth.moreAvailable).toBe(false)
    await file2.close()
  })

  it('ranks occurrences on the memo fast path like a full scan', async () => {
    const items = [
      { a: 'crabapple sauce', b: 'apple sauce' },
      ...Array.from({ length: 10 }, (_, i) => ({ w: `apple s ${i}` }))
    ]
    const path = await fixture('search-memo-rank.json', JSON.stringify(items))
    const file = await JsonFile.open(path)
    await file.search('apple')
    const narrowed = (await file.search('apple s')) as {
      hits: Array<{ index: number; tier: number; snippet: string; matchStart: number; matchLength: number }>
    }
    await file.close()
    // A fresh full scan must produce exactly the same ranking.
    const fresh = await JsonFile.open(path)
    const scanned = (await fresh.search('apple s')) as typeof narrowed
    await fresh.close()
    expect(narrowed).toEqual(scanned)
    expect(narrowed.hits[0]).toMatchObject({ index: 0, tier: 2 })
    for (const hit of narrowed.hits) {
      expect(hit.snippet.slice(hit.matchStart, hit.matchStart + hit.matchLength).toLowerCase()).toBe('apple s')
    }
  })

  it('never classifies object keys as value matches', async () => {
    const file = await JsonFile.open(
      await fixture('search-keys.json', JSON.stringify([{ apple: 1 }, { w: 'apple' }, { 'apple pie': 2 }]))
    )
    const result = (await file.search('apple')) as { hits: Array<{ index: number; tier: number }> }
    expect(result.hits.map((h) => h.index)).toEqual([1, 0, 2])
    expect(result.hits.map((h) => h.tier)).toEqual([1, 3, 3])
    await file.close()
  })

  it('treats strings in nested arrays as values', async () => {
    const file = await JsonFile.open(await fixture('search-nested-value.json', JSON.stringify([['apple', 'banana']])))
    const result = (await file.search('banana')) as { hits: Array<{ tier: number }> }
    expect(result.hits[0].tier).toBe(1)
    await file.close()
  })

  it('cancels a scan through the cancel callback', async () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ text: `item with apple ${i}` }))
    const file = await JsonFile.open(await fixture('search-cancel.json', JSON.stringify(items)))
    await expect(file.search('apple', { isCanceled: () => true })).resolves.toBe(null)
    await file.close()
  })

  it('returns no hits for an empty query', async () => {
    const file = await JsonFile.open(await fixture('search-empty.json', '[{"a":1}]'))
    await expect(file.search('')).resolves.toEqual({ hits: [], moreAvailable: false })
    await file.close()
  })

  it('works on arrays of plain strings', async () => {
    const file = await JsonFile.open(await fixture('search-strings.json', '["banana", "apple", "pineapple"]'))
    const result = (await file.search('apple')) as { hits: Array<{ index: number; tier: number }> }
    expect(result.hits.map((h) => h.index)).toEqual([1, 2])
    expect(result.hits.map((h) => h.tier)).toEqual([1, 3])
    await file.close()
  })

  it('rejects searching non-array roots', async () => {
    const file = await JsonFile.open(await fixture('search-object.json', '{"word": "apple"}'))
    expect(file.searchable).toBe(false)
    await expect(file.search('apple')).rejects.toThrow(JsonError)
    await file.close()
  })
})

describe('non-array roots', () => {
  it('loads an object root', async () => {
    const path = await fixture('object.json', `{\n  "name": "John",\n  "age": 30\n}`)
    const file = await JsonFile.open(path)
    expect(file.root).toEqual({ type: 'value', value: { name: 'John', age: 30 } })
    await file.close()
  })

  it('loads a string root', async () => {
    const path = await fixture('string.json', '"hello"')
    const file = await JsonFile.open(path)
    expect(file.root).toEqual({ type: 'value', value: 'hello' })
    await file.close()
  })

  it('loads a number root', async () => {
    const path = await fixture('number.json', '123')
    const file = await JsonFile.open(path)
    expect(file.root).toEqual({ type: 'value', value: 123 })
    await file.close()
  })

  it('loads null and boolean roots', async () => {
    const n = await JsonFile.open(await fixture('null.json', 'null'))
    expect(n.root).toEqual({ type: 'value', value: null })
    await n.close()
    const t = await JsonFile.open(await fixture('true.json', 'true'))
    expect(t.root).toEqual({ type: 'value', value: true })
    await t.close()
  })

  it('loads a nested object root with arrays inside', async () => {
    const path = await fixture('nested-object.json', '{"word": "apple", "examples": ["I ate an apple.", "The apple is red."]}')
    const file = await JsonFile.open(path)
    expect(file.root).toEqual({
      type: 'value',
      value: { word: 'apple', examples: ['I ate an apple.', 'The apple is red.'] }
    })
    await file.close()
  })
})

describe('invalid input', () => {
  it('reports the line of an invalid primitive element', async () => {
    const path = await fixture('bad-primitive.json', '[\n  1,\n  2,\n  oops\n]')
    await expect(JsonFile.open(path)).rejects.toThrow(JsonError)
    await expect(JsonFile.open(path)).rejects.toThrow(/line 4/)
  })

  it('rejects an unterminated string', async () => {
    const path = await fixture('unterminated.json', '["abc')
    await expect(JsonFile.open(path)).rejects.toThrow(JsonError)
  })

  it('rejects a truncated array', async () => {
    const path = await fixture('truncated.json', '[1, 2')
    await expect(JsonFile.open(path)).rejects.toThrow(/unexpected end/i)
  })

  it('rejects a truncated object root', async () => {
    const path = await fixture('truncated-object.json', '{"a": 1')
    await expect(JsonFile.open(path)).rejects.toThrow(/unexpected end/i)
  })

  it('rejects characters after the root value', async () => {
    const path = await fixture('trailing.json', '{"a": 1} x')
    await expect(JsonFile.open(path)).rejects.toThrow(/after/i)
  })

  it('rejects an empty slot between commas', async () => {
    const path = await fixture('empty-slot.json', '[1,,2]')
    await expect(JsonFile.open(path)).rejects.toThrow(JsonError)
  })

  it('rejects a trailing comma before the closing bracket', async () => {
    const path = await fixture('trailing-comma.json', '[1, 2,]')
    await expect(JsonFile.open(path)).rejects.toThrow(JsonError)
  })

  it('rejects mismatched brackets', async () => {
    const path = await fixture('mismatch.json', '[{"a": 1}]')
    const ok = await JsonFile.open(path)
    expect(ok.root).toEqual({ type: 'array', count: 1 })
    await ok.close()
    // The ']' tries to close the object opened by '{': detected as invalid.
    const bad = await fixture('mismatch2.json', '[{"a": 1]')
    await expect(JsonFile.open(bad)).rejects.toThrow(JsonError)
  })

  it('rejects an invalid object root with a line number', async () => {
    const path = await fixture('bad-object.json', '{\n  "a": 1,\n  "b": oops\n}')
    await expect(JsonFile.open(path)).rejects.toThrow(JsonError)
  })

  it('rejects an empty file', async () => {
    const path = await fixture('empty.json', '')
    await expect(JsonFile.open(path)).rejects.toThrow(/empty/i)
  })

  it('rejects a whitespace-only file', async () => {
    const path = await fixture('blank.json', '  \n \n ')
    await expect(JsonFile.open(path)).rejects.toThrow(/empty/i)
  })

  it('rejects a missing file with a readable error', async () => {
    await expect(JsonFile.open(join(dir, 'does-not-exist.json'))).rejects.toThrow(JsonError)
  })
})
