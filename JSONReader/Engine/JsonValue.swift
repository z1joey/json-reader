import Foundation

/// A user-facing error. `message` is safe to show verbatim in the UI.
struct JsonError: Error, LocalizedError, Equatable {
    let message: String
    var errorDescription: String? { message }
}

/// One `"key": value` pair of a JSON object.
struct JsonMember: Equatable, Sendable {
    var key: String
    var value: JsonValue
}

/// A parsed JSON value. Objects keep their document order, so the read view
/// shows keys the way the file lays them out.
indirect enum JsonValue: Equatable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JsonValue])
    case object([JsonMember])
}

extension JsonValue {
    /// Renders a number the way JavaScript's `String(value)` does, which is
    /// what the previous renderer displayed (`-2.5e3` reads as `-2500`).
    func displayString() -> String {
        switch self {
        case .null: return "null"
        case .bool(let b): return b ? "true" : "false"
        case .number(let n): return Self.formatNumber(n)
        case .string(let s): return s
        case .array, .object: return ""
        }
    }

    static func formatNumber(_ n: Double) -> String {
        if n.isFinite, n == n.rounded(), abs(n) < 1e15 {
            return String(format: "%.0f", n)
        }
        return String(n)
    }
}

/// A strict JSON parser producing order-preserving `JsonValue` trees.
/// `JSONSerialization` would lose object key order, which the reader shows.
struct JsonValueParser {
    private let bytes: [UInt8]
    private var pos = 0
    private var line = 1

    private struct ParseError: Error {
        let message: String
        let line: Int
    }

    private init(_ text: String) {
        bytes = Array(text.utf8)
    }

    /// Parses `text`, throwing a `JsonError` with a 1-based line number when
    /// the text is not valid JSON.
    static func parse(_ text: String) throws -> JsonValue {
        var parser = JsonValueParser(text)
        do {
            let value = try parser.parseValue()
            parser.skipWhitespace()
            if parser.pos < parser.bytes.count {
                throw parser.error("Trailing characters after JSON value.")
            }
            return value
        } catch let error as ParseError {
            throw JsonError(message: "Invalid JSON at line \(error.line).")
        }
    }

    // MARK: - Grammar

    private mutating func parseValue() throws -> JsonValue {
        skipWhitespace()
        guard pos < bytes.count else { throw error("Unexpected end of input.") }
        switch bytes[pos] {
        case UInt8(ascii: "{"): return try parseObject()
        case UInt8(ascii: "["): return try parseArray()
        case UInt8(ascii: "\""): return .string(try parseString())
        case UInt8(ascii: "t"): try expectLiteral("true"); return .bool(true)
        case UInt8(ascii: "f"): try expectLiteral("false"); return .bool(false)
        case UInt8(ascii: "n"): try expectLiteral("null"); return .null
        case UInt8(ascii: "-"), UInt8(ascii: "0")...UInt8(ascii: "9"):
            return .number(try parseNumber())
        default:
            throw error("Unexpected character.")
        }
    }

    private mutating func parseObject() throws -> JsonValue {
        pos += 1 // consume '{'
        var entries: [JsonMember] = []
        skipWhitespace()
        if pos < bytes.count, bytes[pos] == UInt8(ascii: "}") {
            pos += 1
            return .object(entries)
        }
        while true {
            skipWhitespace()
            guard pos < bytes.count, bytes[pos] == UInt8(ascii: "\"") else {
                throw error("Expected a string key.")
            }
            let key = try parseString()
            skipWhitespace()
            guard pos < bytes.count, bytes[pos] == UInt8(ascii: ":") else {
                throw error("Expected ':' after object key.")
            }
            pos += 1
            let value = try parseValue()
            entries.append(JsonMember(key: key, value: value))
            skipWhitespace()
            guard pos < bytes.count else { throw error("Unexpected end of input.") }
            switch bytes[pos] {
            case UInt8(ascii: ","):
                pos += 1
            case UInt8(ascii: "}"):
                pos += 1
                return .object(entries)
            default:
                throw error("Expected ',' or '}' in object.")
            }
        }
    }

    private mutating func parseArray() throws -> JsonValue {
        pos += 1 // consume '['
        var items: [JsonValue] = []
        skipWhitespace()
        if pos < bytes.count, bytes[pos] == UInt8(ascii: "]") {
            pos += 1
            return .array(items)
        }
        while true {
            let value = try parseValue()
            items.append(value)
            skipWhitespace()
            guard pos < bytes.count else { throw error("Unexpected end of input.") }
            switch bytes[pos] {
            case UInt8(ascii: ","):
                pos += 1
            case UInt8(ascii: "]"):
                pos += 1
                return .array(items)
            default:
                throw error("Expected ',' or ']' in array.")
            }
        }
    }

    private mutating func parseString() throws -> String {
        pos += 1 // consume opening quote
        var out = [UInt8]()
        out.reserveCapacity(16)
        while pos < bytes.count {
            let byte = bytes[pos]
            switch byte {
            case UInt8(ascii: "\""):
                pos += 1
                return String(decoding: out, as: UTF8.self)
            case UInt8(ascii: "\\"):
                pos += 1
                guard pos < bytes.count else { break }
                let escape = bytes[pos]
                switch escape {
                case UInt8(ascii: "\""): out.append(UInt8(ascii: "\"")); pos += 1
                case UInt8(ascii: "\\"): out.append(UInt8(ascii: "\\")); pos += 1
                case UInt8(ascii: "/"): out.append(UInt8(ascii: "/")); pos += 1
                case UInt8(ascii: "b"): out.append(0x08); pos += 1
                case UInt8(ascii: "f"): out.append(0x0C); pos += 1
                case UInt8(ascii: "n"): out.append(0x0A); pos += 1
                case UInt8(ascii: "r"): out.append(0x0D); pos += 1
                case UInt8(ascii: "t"): out.append(0x09); pos += 1
                case UInt8(ascii: "u"):
                    pos += 1
                    let scalar = try parseUnicodeEscape()
                    appendScalar(scalar, to: &out)
                default:
                    throw error("Invalid escape sequence.")
                }
            case 0x00...0x1F:
                throw error("Unescaped control character in string.")
            default:
                out.append(byte)
                pos += 1
            }
        }
        throw error("Unterminated string.")
    }

    /// Parses the four hex digits of a `\u` escape. A high surrogate followed
    /// by a low surrogate combines into one scalar; a lone surrogate (like
    /// JavaScript's, which keeps it as a code unit) is written as U+FFFD so
    /// the string stays valid Swift text.
    private mutating func parseUnicodeEscape() throws -> UInt32 {
        let first = try parseHex4()
        guard first >= 0xD800, first <= 0xDBFF, pos + 1 < bytes.count,
              bytes[pos] == UInt8(ascii: "\\"), bytes[pos + 1] == UInt8(ascii: "u") else {
            return first
        }
        pos += 2
        let second = try parseHex4()
        guard second >= 0xDC00, second <= 0xDFFF else {
            pos -= 2
            return first
        }
        return 0x10000 + ((first - 0xD800) << 10) + (second - 0xDC00)
    }

    private mutating func parseHex4() throws -> UInt32 {
        guard pos + 4 <= bytes.count else { throw error("Invalid \\u escape.") }
        var value: UInt32 = 0
        for offset in 0..<4 {
            let byte = bytes[pos + offset]
            let digit: UInt32
            switch byte {
            case UInt8(ascii: "0")...UInt8(ascii: "9"): digit = UInt32(byte - UInt8(ascii: "0"))
            case UInt8(ascii: "a")...UInt8(ascii: "f"): digit = UInt32(byte - UInt8(ascii: "a") + 10)
            case UInt8(ascii: "A")...UInt8(ascii: "F"): digit = UInt32(byte - UInt8(ascii: "A") + 10)
            default: throw error("Invalid \\u escape.")
            }
            value = value << 4 | digit
        }
        pos += 4
        return value
    }

    private func appendScalar(_ scalar: UInt32, to out: inout [UInt8]) {
        let unicode = Unicode.Scalar(scalar) ?? Unicode.Scalar(0xFFFD)!
        out.append(contentsOf: Array(String(unicode).utf8))
    }

    private mutating func parseNumber() throws -> Double {
        let start = pos
        if pos < bytes.count, bytes[pos] == UInt8(ascii: "-") { pos += 1 }
        guard pos < bytes.count else { throw error("Invalid number.") }
        switch bytes[pos] {
        case UInt8(ascii: "0"):
            pos += 1
        case UInt8(ascii: "1")...UInt8(ascii: "9"):
            while pos < bytes.count, (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(bytes[pos]) { pos += 1 }
        default:
            throw error("Invalid number.")
        }
        if pos < bytes.count, bytes[pos] == UInt8(ascii: ".") {
            pos += 1
            guard pos < bytes.count, (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(bytes[pos]) else {
                throw error("Invalid number.")
            }
            while pos < bytes.count, (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(bytes[pos]) { pos += 1 }
        }
        if pos < bytes.count, bytes[pos] == UInt8(ascii: "e") || bytes[pos] == UInt8(ascii: "E") {
            pos += 1
            if pos < bytes.count, bytes[pos] == UInt8(ascii: "+") || bytes[pos] == UInt8(ascii: "-") { pos += 1 }
            guard pos < bytes.count, (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(bytes[pos]) else {
                throw error("Invalid number.")
            }
            while pos < bytes.count, (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(bytes[pos]) { pos += 1 }
        }
        let text = String(decoding: bytes[start..<pos], as: UTF8.self)
        guard let value = Double(text) else { throw error("Invalid number.") }
        return value
    }

    private mutating func expectLiteral(_ literal: String) throws {
        for char in literal.utf8 {
            guard pos < bytes.count, bytes[pos] == char else { throw error("Invalid literal.") }
            pos += 1
        }
    }

    private mutating func skipWhitespace() {
        while pos < bytes.count {
            switch bytes[pos] {
            case 0x20, 0x09, 0x0A, 0x0D:
                if bytes[pos] == 0x0A { line += 1 }
                pos += 1
            default:
                return
            }
        }
    }

    private func error(_ message: String) -> ParseError {
        ParseError(message: message, line: line)
    }
}
