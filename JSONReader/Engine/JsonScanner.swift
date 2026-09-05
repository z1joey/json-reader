import Foundation

/// The result of structurally scanning a JSON file: the byte range of every
/// top-level array element, or a single range covering a non-array root.
struct JsonScanResult: Equatable {
    var starts: [Int]
    var ends: [Int]
    var rootIsArray: Bool
}

/// Streams a file through a byte-level structural scan. All JSON structural
/// characters are ASCII, so multibyte UTF-8 content inside strings never
/// confuses the scanner. For array roots this records the byte range of each
/// top-level element; for other roots it validates the structure before the
/// whole file is parsed.
enum JsonScanner {
    private static let openBracket = UInt8(ascii: "[")
    private static let closeBracket = UInt8(ascii: "]")
    private static let openBrace = UInt8(ascii: "{")
    private static let closeBrace = UInt8(ascii: "}")
    private static let quote = UInt8(ascii: "\"")
    private static let backslash = UInt8(ascii: "\\")
    private static let comma = UInt8(ascii: ",")
    private static let newline = UInt8(ascii: "\n")

    /// Primitive elements longer than this skip the shape check here; the
    /// parser reports them when the item is opened.
    static let maxPrimitivePreview = 256

    private enum Mode { case array, single }
    private enum State { case none, primitive, container, string }

    static func isWhitespace(_ byte: UInt8) -> Bool {
        byte == 0x20 || byte == 0x09 || byte == 0x0A || byte == 0x0D
    }

    /// `true`, `false`, `null`, or a number in strict JSON grammar.
    static func isValidPrimitiveToken(_ text: String) -> Bool {
        switch text {
        case "true", "false", "null": return true
        default: break
        }
        let bytes = Array(text.utf8)
        var i = 0
        func digit(_ index: Int) -> Bool {
            index < bytes.count && bytes[index] >= UInt8(ascii: "0") && bytes[index] <= UInt8(ascii: "9")
        }
        if i < bytes.count, bytes[i] == UInt8(ascii: "-") { i += 1 }
        guard i < bytes.count else { return false }
        if bytes[i] == UInt8(ascii: "0") {
            i += 1
        } else if digit(i) {
            while digit(i) { i += 1 }
        } else {
            return false
        }
        if i < bytes.count, bytes[i] == UInt8(ascii: ".") {
            i += 1
            guard digit(i) else { return false }
            while digit(i) { i += 1 }
        }
        if i < bytes.count, bytes[i] == UInt8(ascii: "e") || bytes[i] == UInt8(ascii: "E") {
            i += 1
            if i < bytes.count, bytes[i] == UInt8(ascii: "+") || bytes[i] == UInt8(ascii: "-") { i += 1 }
            guard digit(i) else { return false }
            while digit(i) { i += 1 }
        }
        return i == bytes.count
    }

    static func scan(handle: FileHandle, size: Int, chunkSize: Int) throws -> JsonScanResult {
        if size == 0 { throw JsonError(message: "The file is empty.") }
        let bufferSize = max(4, min(chunkSize, size))

        var starts: [Int] = []
        var ends: [Int] = []
        var filePos = 0
        var line = 1

        var started = false
        var mode = Mode.single
        var stack: [UInt8] = [] // expected closing byte for each open container
        var state = State.none
        var elemStart = 0
        var primPreview: [UInt8] = []
        var primLine = 1
        var needComma = false
        var elementDone = false
        var inString = false
        var escaped = false
        var rootClosed = false

        func baseDepth() -> Int { mode == .array ? 1 : 0 }
        func topLevel() -> Bool { stack.count == baseDepth() }

        func fail() -> JsonError {
            JsonError(message: "Invalid JSON at line \(line).")
        }

        func finishElement(_ end: Int) {
            starts.append(elemStart)
            ends.append(end)
            state = .none
            if mode == .array { needComma = true } else { elementDone = true }
        }

        func finishPrimitive(_ end: Int) throws {
            let text = String(decoding: primPreview, as: UTF8.self)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if text.count <= maxPrimitivePreview, !isValidPrimitiveToken(text) {
                throw JsonError(message: "Invalid JSON at line \(primLine).")
            }
            finishElement(end)
        }

        func readChunk(at offset: Int) throws -> [UInt8] {
            try handle.seek(toOffset: UInt64(offset))
            guard let data = try handle.read(upToCount: bufferSize) else { return [] }
            return [UInt8](data)
        }

        scan: while filePos < size {
            let buffer = try readChunk(at: filePos)
            if buffer.isEmpty { break }
            let chunkStart = filePos
            filePos += buffer.count
            // A UTF-8 BOM at the start of the file is skipped.
            let from = chunkStart == 0 && buffer.count >= 3 && buffer[0] == 0xEF && buffer[1] == 0xBB && buffer[2] == 0xBF ? 3 : 0

            var i = from
            while i < buffer.count {
                let byte = buffer[i]
                let pos = chunkStart + i
                defer { i += 1 }

                if inString {
                    if escaped {
                        escaped = false
                    } else if byte == backslash {
                        escaped = true
                    } else if byte == quote {
                        inString = false
                        if state == .string { finishElement(pos + 1) }
                    }
                } else if !started {
                    if !isWhitespace(byte) {
                        started = true
                        if byte == openBracket {
                            mode = .array
                            stack.append(closeBracket)
                        } else if byte == quote {
                            state = .string
                            elemStart = pos
                            inString = true
                        } else if byte == openBrace {
                            state = .container
                            elemStart = pos
                            stack.append(closeBrace)
                        } else if byte == closeBracket || byte == closeBrace {
                            throw fail()
                        } else {
                            state = .primitive
                            elemStart = pos
                            primPreview = [byte]
                            primLine = line
                        }
                    }
                } else if byte == quote {
                    if topLevel() {
                        if needComma || state == .primitive || elementDone { throw fail() }
                        state = .string
                        elemStart = pos
                    }
                    inString = true
                } else if byte == openBracket || byte == openBrace {
                    if topLevel() {
                        if needComma || state == .primitive || elementDone { throw fail() }
                        state = .container
                        elemStart = pos
                    }
                    stack.append(byte == openBracket ? closeBracket : closeBrace)
                } else if byte == closeBracket || byte == closeBrace {
                    if topLevel(), state == .primitive { try finishPrimitive(pos) }
                    let expected = stack.popLast()
                    if expected != byte { throw fail() }
                    if mode == .array, stack.isEmpty {
                        // A close is legal right after an element, or before any
                        // element exists ([1,] and [,] are the illegal combinations).
                        if !needComma, !starts.isEmpty { throw fail() }
                        rootClosed = true
                        // Resume the trailing-content check right after ']' — not
                        // at the end of this chunk — so garbage in the same chunk
                        // is still seen.
                        filePos = pos + 1
                        break scan
                    }
                    if stack.count == baseDepth(), state == .container { finishElement(pos + 1) }
                } else if topLevel() {
                    if isWhitespace(byte) {
                        // Whitespace between (or trailing inside) a primitive is fine.
                        if state == .primitive, primPreview.count <= maxPrimitivePreview { primPreview.append(0x20) }
                    } else if byte == comma {
                        if state == .primitive { try finishPrimitive(pos) }
                        if mode == .single || !needComma { throw fail() }
                        needComma = false
                    } else {
                        if elementDone {
                            throw JsonError(message: "Invalid JSON: unexpected characters after the JSON value at line \(line).")
                        }
                        if state == .primitive {
                            if primPreview.count <= maxPrimitivePreview { primPreview.append(byte) }
                        } else {
                            if needComma { throw fail() } // a second element without a separating comma
                            state = .primitive
                            elemStart = pos
                            primPreview = [byte]
                            primLine = line
                        }
                    }
                }
                // Bytes inside a container element (colons, digits, ...) need no
                // handling here; the element is validated by the parser in item().

                if byte == newline { line += 1 }
            }
        }

        if !started { throw JsonError(message: "The file is empty.") }
        if inString { throw JsonError(message: "Invalid JSON: unterminated string at line \(line).") }
        if mode == .single, state == .primitive { try finishPrimitive(size) }
        // In single mode the root value needs no closing bracket: a completed
        // element is a complete document.
        if !rootClosed, !elementDone {
            throw JsonError(message: "Invalid JSON: unexpected end of file at line \(line).")
        }

        // Anything after the root value must be whitespace.
        while filePos < size {
            let buffer = try readChunk(at: filePos)
            if buffer.isEmpty { break }
            filePos += buffer.count
            for byte in buffer {
                if !isWhitespace(byte) {
                    throw JsonError(message: "Invalid JSON: unexpected characters after the JSON value at line \(line).")
                }
                if byte == newline { line += 1 }
            }
        }

        return JsonScanResult(starts: starts, ends: ends, rootIsArray: mode == .array)
    }
}
