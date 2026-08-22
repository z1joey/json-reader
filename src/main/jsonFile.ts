import { open as fsOpen, type FileHandle } from 'node:fs/promises'
import type { SearchHit, SearchTier } from '../shared/types'

/**
 * Error with a user-facing message. `line`, when set, refers to the
 * 1-based line in the JSON file where the problem was detected.
 */
export class JsonError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JsonError'
  }
}

export type RootInfo = { type: 'array'; count: number } | { type: 'value'; value: unknown }

const OPEN_BRACKET = 0x5b
const CLOSE_BRACKET = 0x5d
const OPEN_BRACE = 0x7b
const CLOSE_BRACE = 0x7d
const QUOTE = 0x22
const BACKSLASH = 0x5c
const COMMA = 0x2c
const NEWLINE = 0x0a
const SPACE = 0x20
const TAB = 0x09
const CR = 0x0d

function isWhitespace(byte: number): boolean {
  return byte === SPACE || byte === TAB || byte === NEWLINE || byte === CR
}

const PRIMITIVE_RE = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/

/** Root values that are not arrays must fit in memory; array roots never do. */
const MAX_SINGLE_VALUE_BYTES = 256 * 1024 * 1024

const MAX_PRIMITIVE_PREVIEW = 256

const SEARCH_LIMIT = 10

/**
 * Decides whether the quote at `quoteAt` opens a JSON string in a *value*
 * position: a bare string element, an array element, or the value after a
 * `"key":` pair. A quote that opens an object key is not a value position,
 * so matches inside keys never rank as value matches.
 */
function opensValueString(text: string, quoteAt: number): boolean {
  let i = quoteAt - 1
  while (i >= 0 && /\s/.test(text[i])) i--
  if (i < 0) return true
  if (text[i] === ':' || text[i] === '[') return true
  if (text[i] !== ',') return false
  // After a comma the quote opens a value in an array but a key in an
  // object; walk back to the enclosing bracket, jumping over string
  // literals, to tell which one it is.
  let depth = 0
  while (i >= 0) {
    const ch = text[i]
    if (ch === '"') {
      // An unescaped quote bounds a string literal; skip past its partner.
      let slashes = 0
      for (let j = i - 1; j >= 0 && text[j] === '\\'; j--) slashes++
      if (slashes % 2 === 0) {
        let k = i - 1
        while (k >= 0) {
          if (text[k] === '"') {
            let inner = 0
            for (let m = k - 1; m >= 0 && text[m] === '\\'; m--) inner++
            if (inner % 2 === 0) break
          }
          k--
        }
        i = k - 1
        continue
      }
    } else if (ch === ']' || ch === '}') depth++
    else if (ch === '[' || ch === '{') {
      if (depth === 0) return ch === '['
      depth--
    }
    i--
  }
  return false
}

const SNIPPET_RADIUS = 40

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function readError(err: unknown): JsonError {
  const code = (err as NodeJS.ErrnoException | null)?.code
  if (code === 'ENOENT') return new JsonError('The file could not be found.')
  if (code === 'EACCES' || code === 'EPERM') return new JsonError('The file could not be read (permission denied).')
  if (code === 'EISDIR') return new JsonError('That path is a folder, not a file.')
  return new JsonError('The file could not be read.')
}

/**
 * True when the quote at `quoteAt` is escaped by an odd run of backslashes.
 */
function isEscapedQuote(text: string, quoteAt: number): boolean {
  let slashes = 0
  for (let i = quoteAt - 1; i >= 0 && text[i] === '\\'; i--) slashes++
  return slashes % 2 === 1
}

/**
 * Classifies one occurrence of a match in raw element text by looking at the
 * characters around it. Tier 1 means the match sits alone between quotes as a
 * complete JSON string value; tier 2 means it starts a string value; anything
 * else is tier 3. Matches inside object keys are always tier 3.
 */
function classifyMatch(text: string, at: number, length: number): SearchTier {
  const quoteBefore = at - 1
  if (quoteBefore < 0 || text[quoteBefore] !== '"') return 3
  if (isEscapedQuote(text, quoteBefore) || !opensValueString(text, quoteBefore)) return 3
  const after = text[at + length]
  if (after === '"' && !isEscapedQuote(text, at + length)) return 1
  if (after === undefined) return 3
  return 2
}

/**
 * Finds the best-ranked occurrence of `needle` (already lowercase) in raw
 * element text, or null when it does not appear.
 */
function bestOccurrence(text: string, needle: string): { tier: SearchTier; at: number } | null {
  const hay = text.toLowerCase()
  let best: { tier: SearchTier; at: number } | null = null
  let from = 0
  while (from <= hay.length - needle.length) {
    const at = hay.indexOf(needle, from)
    if (at === -1) break
    const tier = classifyMatch(text, at, needle.length)
    if (tier === 1) return { tier, at }
    if (!best || tier < best.tier) best = { tier, at }
    from = at + 1
  }
  return best
}

/** The `"key":` label immediately enclosing a match position, if any. */
function enclosingField(text: string, at: number): string | null {
  // Walk back to the unescaped quote that opens the string holding the match…
  let i = at - 1
  while (i >= 0 && !(text[i] === '"' && !isEscapedQuote(text, i))) i--
  if (i < 0) return null
  // …which must be introduced by a `"key":` pair.
  let j = skipWhitespaceBack(text, i - 1)
  if (j < 0 || text[j] !== ':') return null
  j = skipWhitespaceBack(text, j - 1)
  if (j < 0 || text[j] !== '"' || isEscapedQuote(text, j)) return null
  const keyClose = j
  let k = keyClose - 1
  while (k >= 0 && !(text[k] === '"' && !isEscapedQuote(text, k))) k--
  if (k < 0) return null
  return text
    .slice(k + 1, keyClose)
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
}

function skipWhitespaceBack(text: string, from: number): number {
  let i = from
  while (i >= 0 && /\s/.test(text[i])) i--
  return i
}

/** A one-line excerpt around a match, ellipsized on both sides as needed. */
function makeSnippet(text: string, at: number, length: number): {
  snippet: string
  matchStart: number
  matchLength: number
} {
  let start = Math.max(0, at - SNIPPET_RADIUS)
  let end = Math.min(text.length, at + length + SNIPPET_RADIUS)
  // Do not cut a surrogate pair in half at either edge.
  if (start > 0 && text.charCodeAt(start) >= 0xdc00 && text.charCodeAt(start) <= 0xdfff) start--
  if (end < text.length && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) end--
  const collapse = (part: string): string => part.replace(/\s+/g, ' ')
  const lead = start > 0 ? '…' : ''
  const tail = end < text.length ? '…' : ''
  const before = collapse(text.slice(start, at)).trimStart()
  const mid = collapse(text.slice(at, at + length))
  const after = collapse(text.slice(at + length, end)).trimEnd()
  return { snippet: lead + before + mid + after + tail, matchStart: lead.length + before.length, matchLength: mid.length }
}

/**
 * Provides access to a JSON file without materializing all of it.
 *
 * When the root of the document is an array, opening the file only records
 * the byte range of every top-level element; each element is then read and
 * parsed individually by `item()`. This keeps both the memory footprint and
 * the cost of navigating between items low, even for files with hundreds of
 * thousands of elements. Any other root value is parsed in full up front.
 */
export class JsonFile {
  private fd: FileHandle | null = null
  private starts: number[] = []
  private ends: number[] = []
  private rootValue: unknown
  private rootIsArray = false
  private searchMemo: { query: string; indices: number[]; moreAvailable: boolean } | null = null

  private constructor() {}

  static async open(path: string, options: { chunkSize?: number } = {}): Promise<JsonFile> {
    const file = new JsonFile()
    let handle: FileHandle
    try {
      handle = await fsOpen(path, 'r')
    } catch (err) {
      throw readError(err)
    }
    file.fd = handle
    try {
      await file.analyze(handle, options.chunkSize ?? 1 << 20)
    } catch (err) {
      await file.close()
      throw err
    }
    if (!file.rootIsArray) await file.close()
    return file
  }

  get root(): RootInfo {
    return this.rootIsArray
      ? { type: 'array', count: this.starts.length }
      : { type: 'value', value: this.rootValue }
  }

  /** Search is only meaningful for array roots. */
  get searchable(): boolean {
    return this.rootIsArray
  }

  async item(index: number): Promise<unknown> {
    if (!this.rootIsArray || !this.fd) throw new JsonError('The file is no longer open.')
    if (!Number.isInteger(index) || index < 0 || index >= this.starts.length) {
      throw new JsonError('The item index is out of range.')
    }
    const buffer = await this.readSlice(this.starts[index], this.ends[index])
    try {
      return JSON.parse(buffer.toString('utf8'))
    } catch (err) {
      throw new JsonError(`Item ${index + 1} is not valid JSON: ${errorMessage(err)}`)
    }
  }

  /**
   * Case-insensitively searches every element's raw text for `query` and
   * returns up to ten hits ranked by match quality (exact string values
   * first, then value prefixes, then any occurrence). Elements are read one
   * at a time via their byte ranges, so nothing is materialized up front.
   *
   * Returns null when the scan was canceled through `options.isCanceled`.
   * When the query extends the previous one, the previous hits are re-verified
   * first, which usually avoids a second pass over large files.
   */
  async search(
    query: string,
    options: { isCanceled?: () => boolean } = {}
  ): Promise<{ hits: SearchHit[]; moreAvailable: boolean } | null> {
    if (!this.rootIsArray || !this.fd) throw new JsonError('Search needs an open JSON array file.')
    const needle = query.toLowerCase()
    if (needle.length === 0) return { hits: [], moreAvailable: false }
    const isCanceled = options.isCanceled ?? (() => false)

    // A longer query can only match inside the previous query's matches.
    // Re-verify those few elements instead of rescanning the whole file;
    // fall back to a full scan when too few survive.
    const memo = this.searchMemo
    if (memo && needle.startsWith(memo.query)) {
      const verified: SearchHit[] = []
      for (const index of memo.indices) {
        if (isCanceled()) return null
        const text = (await this.readSlice(this.starts[index], this.ends[index])).toString('utf8')
        // Rank occurrences exactly like the full scan does so both paths
        // agree on tier and snippet for the same element.
        const found = bestOccurrence(text, needle)
        if (!found) continue
        verified.push({
          index,
          tier: found.tier,
          field: enclosingField(text, found.at),
          ...makeSnippet(text, found.at, needle.length)
        })
      }
      // The memo cannot know about matches its source scan never saw, so it
      // can never turn a `false` into a `true`.
      if (verified.length >= SEARCH_LIMIT) {
        return { hits: verified.slice(0, SEARCH_LIMIT), moreAvailable: memo.moreAvailable }
      }
    }

    type Pick = { index: number; tier: SearchTier; at: number }
    const picks: Pick[] = []
    let dropped = false
    let scannedAll = true

    scan: for (let i = 0; i < this.starts.length; i++) {
      if (isCanceled()) return null
      const text = (await this.readSlice(this.starts[i], this.ends[i])).toString('utf8')
      const found = bestOccurrence(text, needle)
      if (!found) continue
      // Picks are collected in index order; keep the list sorted by tier so
      // the best ten survive regardless of where they were found.
      let slot = picks.length
      while (slot > 0 && picks[slot - 1].tier > found.tier) slot--
      if (picks.length < SEARCH_LIMIT) {
        picks.splice(slot, 0, { index: i, ...found })
      } else if (slot < SEARCH_LIMIT) {
        picks.splice(slot, 0, { index: i, ...found })
        picks.pop()
        dropped = true
      } else {
        dropped = true
      }
      // Ten exact matches cannot be outranked by anything later in the file.
      if (picks.length === SEARCH_LIMIT && picks[SEARCH_LIMIT - 1].tier === 1) {
        if (i < this.starts.length - 1) scannedAll = false
        break scan
      }
    }

    const hits = await Promise.all(
      picks.map(async (pick): Promise<SearchHit> => {
        const text = (await this.readSlice(this.starts[pick.index], this.ends[pick.index])).toString('utf8')
        return {
          index: pick.index,
          tier: pick.tier,
          field: enclosingField(text, pick.at),
          ...makeSnippet(text, pick.at, needle.length)
        }
      })
    )
    this.searchMemo = { query: needle, indices: picks.map((p) => p.index), moreAvailable: dropped || !scannedAll }
    return { hits, moreAvailable: dropped || !scannedAll }
  }

  private async readSlice(start: number, end: number): Promise<Buffer> {
    if (!this.fd) throw new JsonError('The file is no longer open.')
    const length = end - start
    const buffer = Buffer.alloc(length)
    let total = 0
    while (total < length) {
      const { bytesRead } = await this.fd.read(buffer, total, length - total, start + total)
      if (bytesRead === 0) throw new JsonError('The file ended unexpectedly while reading an item.')
      total += bytesRead
    }
    return buffer
  }

  async close(): Promise<void> {
    if (this.fd) {
      const fd = this.fd
      this.fd = null
      await fd.close().catch(() => {})
    }
  }

  private addElement(start: number, end: number): void {
    this.starts.push(start)
    this.ends.push(end)
  }

  /**
   * Streams the file through a byte-level structural scan. All JSON
   * structural characters are ASCII, so multibyte UTF-8 content inside
   * strings never confuses the scanner. For array roots this records the
   * byte range of each top-level element; for other roots it validates the
   * structure before the whole file is parsed.
   */
  private async analyze(handle: FileHandle, chunkSize: number): Promise<void> {
    const { size } = await handle.stat()
    if (size === 0) throw new JsonError('The file is empty.')

    const buffer = Buffer.alloc(Math.max(4, Math.min(chunkSize, size)))
    let filePos = 0
    let line = 1

    let started = false
    let mode: 'array' | 'single' = 'single'
    const stack: number[] = [] // expected closing byte for each open container
    let state: 'none' | 'primitive' | 'container' | 'string' = 'none'
    let elemStart = 0
    let primPreview = ''
    let primLine = 1
    let needComma = false
    let elementDone = false
    let inString = false
    let escaped = false
    let rootClosed = false

    const baseDepth = (): number => (mode === 'array' ? 1 : 0)
    const topLevel = (): boolean => stack.length === baseDepth()

    const fail = (): never => {
      throw new JsonError(`Invalid JSON at line ${line}.`)
    }

    const finishPrimitive = (end: number): void => {
      const text = primPreview.trim()
      if (text.length <= MAX_PRIMITIVE_PREVIEW && !PRIMITIVE_RE.test(text)) {
        throw new JsonError(`Invalid JSON at line ${primLine}.`)
      }
      this.addElement(elemStart, end)
      state = 'none'
      if (mode === 'array') needComma = true
      else elementDone = true
    }

    const finishElement = (end: number): void => {
      this.addElement(elemStart, end)
      state = 'none'
      if (mode === 'array') needComma = true
      else elementDone = true
    }

    scan: while (filePos < size) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, filePos)
      if (bytesRead === 0) break
      const chunkStart = filePos
      filePos += bytesRead
      // A UTF-8 BOM at the start of the file is skipped.
      const from =
        chunkStart === 0 && bytesRead >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf ? 3 : 0

      for (let i = from; i < bytesRead; i++) {
        const byte = buffer[i]
        if (byte === undefined) break
        const pos = chunkStart + i

        if (inString) {
          if (escaped) escaped = false
          else if (byte === BACKSLASH) escaped = true
          else if (byte === QUOTE) {
            inString = false
            if (state === 'string') finishElement(pos + 1)
          }
        } else if (!started) {
          if (!isWhitespace(byte)) {
            started = true
            if (byte === OPEN_BRACKET) {
              mode = 'array'
              stack.push(CLOSE_BRACKET)
            } else if (byte === QUOTE) {
              state = 'string'
              elemStart = pos
              inString = true
            } else if (byte === OPEN_BRACE) {
              state = 'container'
              elemStart = pos
              stack.push(CLOSE_BRACE)
            } else if (byte === CLOSE_BRACKET || byte === CLOSE_BRACE) {
              fail()
            } else {
              state = 'primitive'
              elemStart = pos
              primPreview = String.fromCharCode(byte)
              primLine = line
            }
          }
        } else if (byte === QUOTE) {          if (topLevel()) {
            if (needComma || state === 'primitive' || elementDone) fail()
            state = 'string'
            elemStart = pos
          }
          inString = true
        } else if (byte === OPEN_BRACKET || byte === OPEN_BRACE) {
          if (topLevel()) {
            if (needComma || state === 'primitive' || elementDone) fail()
            state = 'container'
            elemStart = pos
          }
          stack.push(byte === OPEN_BRACKET ? CLOSE_BRACKET : CLOSE_BRACE)
        } else if (byte === CLOSE_BRACKET || byte === CLOSE_BRACE) {
          if (topLevel() && state === 'primitive') finishPrimitive(pos)
          const expected = stack.pop()
          if (expected !== byte) fail()
          if (mode === 'array' && stack.length === 0) {
            // A close is legal right after an element, or before any element
            // exists ([1,] and [,] are the illegal combinations).
            if (!needComma && this.starts.length > 0) fail()
            rootClosed = true
            break scan
          }
          if (stack.length === baseDepth() && state === 'container') finishElement(pos + 1)
        } else if (topLevel()) {
          if (isWhitespace(byte)) {
            // whitespace between (or trailing inside) a primitive is fine
            if (state === 'primitive' && primPreview.length <= MAX_PRIMITIVE_PREVIEW) primPreview += ' '
          } else if (byte === COMMA) {
            if (state === 'primitive') finishPrimitive(pos)
            if (mode === 'single' || !needComma) fail()
            needComma = false
          } else {
            if (elementDone) {
              throw new JsonError(`Invalid JSON: unexpected characters after the JSON value at line ${line}.`)
            }
            if (state === 'primitive') {
              if (primPreview.length <= MAX_PRIMITIVE_PREVIEW) primPreview += String.fromCharCode(byte)
            } else {
              if (needComma) fail() // a second element without a separating comma
              state = 'primitive'
              elemStart = pos
              primPreview = String.fromCharCode(byte)
              primLine = line
            }
          }
        }
        // Bytes inside a container element (colons, digits, ...) need no
        // handling here; the element is validated by JSON.parse in item().

        if (byte === NEWLINE) line++
      }
    }

    if (!started) throw new JsonError('The file is empty.')
    if (inString) throw new JsonError(`Invalid JSON: unterminated string at line ${line}.`)
    if (mode === 'single' && state === 'primitive') finishPrimitive(size)
    // In single mode the root value needs no closing bracket: a completed
    // element is a complete document.
    if (!rootClosed && !elementDone) {
      throw new JsonError(`Invalid JSON: unexpected end of file at line ${line}.`)
    }

    // Anything after the root value must be whitespace.
    while (filePos < size) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, filePos)
      if (bytesRead === 0) break
      filePos += bytesRead
      for (let i = 0; i < bytesRead; i++) {
        const byte = buffer[i]
        if (byte === undefined) break
        if (!isWhitespace(byte)) {
          throw new JsonError(`Invalid JSON: unexpected characters after the JSON value at line ${line}.`)
        }
        if (byte === NEWLINE) line++
      }
    }

    if (mode === 'array') {
      this.rootIsArray = true
      return
    }

    if (size > MAX_SINGLE_VALUE_BYTES) {
      throw new JsonError('This file is too large to open. Only files whose root is a JSON array can be this big.')
    }
    this.rootValue = await this.parseWhole(handle, size)
  }

  private async parseWhole(handle: FileHandle, size: number): Promise<unknown> {
    const buffer = Buffer.alloc(size)
    let total = 0
    while (total < size) {
      const { bytesRead } = await handle.read(buffer, total, size - total, total)
      if (bytesRead === 0) break
      total += bytesRead
    }
    const text = buffer.toString('utf8').replace(/^\uFEFF/, '')
    try {
      return JSON.parse(text)
    } catch (err) {
      const match = errorMessage(err).match(/position (\d+)/)
      if (match) {
        const line = 1 + text.slice(0, Number(match[1])).split('\n').length - 1
        throw new JsonError(`Invalid JSON at line ${line}.`)
      }
      throw new JsonError(`Invalid JSON: ${errorMessage(err)}`)
    }
  }
}
