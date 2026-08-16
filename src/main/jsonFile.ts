import { open as fsOpen, type FileHandle } from 'node:fs/promises'

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

  async item(index: number): Promise<unknown> {
    if (!this.rootIsArray || !this.fd) throw new JsonError('The file is no longer open.')
    if (!Number.isInteger(index) || index < 0 || index >= this.starts.length) {
      throw new JsonError('The item index is out of range.')
    }
    const start = this.starts[index]
    const end = this.ends[index]
    const length = end - start
    const buffer = Buffer.alloc(length)
    let total = 0
    while (total < length) {
      const { bytesRead } = await this.fd.read(buffer, total, length - total, start + total)
      if (bytesRead === 0) throw new JsonError('The file ended unexpectedly while reading an item.')
      total += bytesRead
    }
    try {
      return JSON.parse(buffer.toString('utf8'))
    } catch (err) {
      throw new JsonError(`Item ${index + 1} is not valid JSON: ${errorMessage(err)}`)
    }
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
