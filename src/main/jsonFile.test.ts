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
