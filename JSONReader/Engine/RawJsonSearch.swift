import Foundation

/// How directly an element matches a search query:
/// 1 = some JSON string value equals the query,
/// 2 = some string value starts with the query,
/// 3 = the query appears anywhere in the element's text.
typealias SearchTier = Int

/// A search hit inside one JSON file, before file identity is attached.
struct SearchHitBase: Equatable, Sendable {
    /// Index of the matching top-level element inside that file.
    var index: Int
    var tier: SearchTier
    /// Name of the field enclosing the first match, when detectable.
    var field: String?
    /// Short excerpt of the element's raw text around the first match.
    var snippet: String
    /// UTF-8 byte offset of the matched query inside `snippet`, for highlighting.
    var matchStart: Int
    /// UTF-8 byte length of the matched query inside `snippet`.
    var matchLength: Int
}

struct SearchHit: Equatable, Sendable, Identifiable {
    var base: SearchHitBase
    /// Index of the file in the currently opened folder.
    var fileIndex: Int
    /// Display name of the file containing the hit.
    var fileName: String

    var id: String { "\(fileIndex)-\(base.index)" }
    var index: Int { base.index }
    var tier: SearchTier { base.tier }
    var field: String? { base.field }
    var snippet: String { base.snippet }
}

extension SearchHitBase {
    /// The snippet split around the match so a view can highlight the middle.
    var snippetParts: (before: String, match: String, after: String) {
        let utf8 = snippet.utf8
        guard matchLength > 0, matchStart >= 0, matchStart + matchLength <= utf8.count,
              let start = utf8.index(utf8.startIndex, offsetBy: matchStart, limitedBy: utf8.endIndex),
              let end = utf8.index(start, offsetBy: matchLength, limitedBy: utf8.endIndex) else {
            return (snippet, "", "")
        }
        return (String(snippet[..<start]), String(snippet[start..<end]), String(snippet[end...]))
    }
}

/// Match ranking and excerpting over the raw UTF-8 text of a JSON element.
/// All the structural characters this inspects (`"`, `\`, `:`, brackets) are
/// ASCII, so working on bytes is exact even for multibyte string content.
enum RawJsonSearch {
    struct Occurrence: Equatable {
        var tier: SearchTier
        var at: Int
    }

    struct Snippet: Equatable {
        var snippet: String
        var matchStart: Int
        var matchLength: Int
    }

    struct TextMatch: Equatable {
        var tier: SearchTier
        var field: String?
        var snippet: String
        var matchStart: Int
        var matchLength: Int
    }

    private static let quote = UInt8(ascii: "\"")
    private static let backslash = UInt8(ascii: "\\")
    private static let colon = UInt8(ascii: ":")
    private static let comma = UInt8(ascii: ",")
    private static let openBracket = UInt8(ascii: "[")
    private static let closeBracket = UInt8(ascii: "]")
    private static let openBrace = UInt8(ascii: "{")
    private static let closeBrace = UInt8(ascii: "}")

    private static let snippetRadius = 40

    /// Lowercases text for matching. Case folding may change byte length for
    /// a few scripts; the match offset is then read against the original
    /// bytes like the previous implementation did, which is exact for the
    /// ASCII structure that ranking depends on.
    static func lowercased(_ bytes: [UInt8]) -> [UInt8] {
        Array(String(decoding: bytes, as: UTF8.self).lowercased().utf8)
    }

    static func isWhitespace(_ byte: UInt8) -> Bool {
        byte == 0x20 || byte == 0x09 || byte == 0x0A || byte == 0x0D || byte == 0x0B || byte == 0x0C
    }

    /// Finds `needle` in `hay` starting at `from`, or nil.
    static func indexOf(_ needle: [UInt8], in hay: [UInt8], from: Int) -> Int? {
        guard !needle.isEmpty, from >= 0, from <= hay.count - needle.count else { return nil }
        return hay.withUnsafeBufferPointer { h -> Int? in
            needle.withUnsafeBufferPointer { n -> Int? in
                guard let base = h.baseAddress, let nBase = n.baseAddress else { return nil }
                guard let found = memmem(base + from, h.count - from, nBase, n.count) else { return nil }
                return UnsafeRawPointer(found) - UnsafeRawPointer(base)
            }
        }
    }

    /// True when the quote at `quoteAt` is escaped by an odd run of backslashes.
    static func isEscapedQuote(_ text: [UInt8], _ quoteAt: Int) -> Bool {
        var slashes = 0
        var i = quoteAt - 1
        while i >= 0, text[i] == backslash {
            slashes += 1
            i -= 1
        }
        return slashes % 2 == 1
    }

    /// Decides whether the quote at `quoteAt` opens a JSON string in a *value*
    /// position: a bare string element, an array element, or the value after a
    /// `"key":` pair. A quote that opens an object key is not a value position,
    /// so matches inside keys never rank as value matches.
    static func opensValueString(_ text: [UInt8], _ quoteAt: Int) -> Bool {
        var i = quoteAt - 1
        while i >= 0, isWhitespace(text[i]) { i -= 1 }
        if i < 0 { return true }
        if text[i] == colon || text[i] == openBracket { return true }
        if text[i] != comma { return false }
        // After a comma the quote opens a value in an array but a key in an
        // object; walk back to the enclosing bracket, jumping over string
        // literals, to tell which one it is.
        var depth = 0
        while i >= 0 {
            let ch = text[i]
            if ch == quote {
                // An unescaped quote bounds a string literal; skip past its partner.
                if !isEscapedQuote(text, i) {
                    var k = i - 1
                    while k >= 0 {
                        if text[k] == quote, !isEscapedQuote(text, k) { break }
                        k -= 1
                    }
                    i = k - 1
                    continue
                }
            } else if ch == closeBracket || ch == closeBrace {
                depth += 1
            } else if ch == openBracket || ch == openBrace {
                if depth == 0 { return ch == openBracket }
                depth -= 1
            }
            i -= 1
        }
        return false
    }

    /// Classifies one occurrence of a match by looking at the bytes around it.
    static func classifyMatch(_ text: [UInt8], at: Int, length: Int) -> SearchTier {
        let quoteBefore = at - 1
        if quoteBefore < 0 || quoteBefore >= text.count || text[quoteBefore] != quote { return 3 }
        if isEscapedQuote(text, quoteBefore) || !opensValueString(text, quoteBefore) { return 3 }
        let afterIndex = at + length
        if afterIndex >= text.count { return 3 }
        if text[afterIndex] == quote, !isEscapedQuote(text, afterIndex) { return 1 }
        return 2
    }

    /// Finds the best-ranked occurrence of `needle` (already lowercase) in raw
    /// element text, or nil when it does not appear.
    static func bestOccurrence(_ text: [UInt8], needle: [UInt8]) -> Occurrence? {
        let hay = lowercased(text)
        var best: Occurrence?
        var from = 0
        while from <= hay.count - needle.count {
            guard let at = indexOf(needle, in: hay, from: from) else { break }
            let tier = classifyMatch(text, at: at, length: needle.count)
            if tier == 1 { return Occurrence(tier: 1, at: at) }
            if best == nil || tier < best!.tier { best = Occurrence(tier: tier, at: at) }
            from = at + 1
        }
        return best
    }

    private static func skipWhitespaceBack(_ text: [UInt8], _ from: Int) -> Int {
        var i = from
        while i >= 0, isWhitespace(text[i]) { i -= 1 }
        return i
    }

    /// The `"key":` label immediately enclosing a match position, if any.
    static func enclosingField(_ text: [UInt8], at: Int) -> String? {
        // Walk back to the unescaped quote that opens the string holding the match…
        var i = min(at, text.count) - 1
        while i >= 0, !(text[i] == quote && !isEscapedQuote(text, i)) { i -= 1 }
        if i < 0 { return nil }
        // …which must be introduced by a `"key":` pair.
        var j = skipWhitespaceBack(text, i - 1)
        if j < 0 || text[j] != colon { return nil }
        j = skipWhitespaceBack(text, j - 1)
        if j < 0 || text[j] != quote || isEscapedQuote(text, j) { return nil }
        let keyClose = j
        var k = keyClose - 1
        while k >= 0, !(text[k] == quote && !isEscapedQuote(text, k)) { k -= 1 }
        if k < 0 { return nil }
        let raw = String(decoding: text[(k + 1)..<keyClose], as: UTF8.self)
        return raw
            .replacingOccurrences(of: "\\\"", with: "\"")
            .replacingOccurrences(of: "\\\\", with: "\\")
    }

    private static func isContinuation(_ byte: UInt8) -> Bool {
        byte & 0xC0 == 0x80
    }

    private static func collapse(_ part: ArraySlice<UInt8>) -> [UInt8] {
        var out: [UInt8] = []
        out.reserveCapacity(part.count)
        var inRun = false
        for byte in part {
            if isWhitespace(byte) {
                if !inRun { out.append(0x20) }
                inRun = true
            } else {
                out.append(byte)
                inRun = false
            }
        }
        return out
    }

    /// A one-line excerpt around a match, ellipsized on both sides as needed.
    static func makeSnippet(_ text: [UInt8], at: Int, length: Int) -> Snippet {
        var start = max(0, at - snippetRadius)
        var end = min(text.count, at + length + snippetRadius)
        // Never cut a multibyte character in half at either edge.
        while start > 0, start < text.count, isContinuation(text[start]) { start -= 1 }
        while end < text.count, isContinuation(text[end]) { end += 1 }
        let matchEnd = min(at + length, text.count)
        let lead: [UInt8] = start > 0 ? Array("…".utf8) : []
        let tail: [UInt8] = end < text.count ? Array("…".utf8) : []
        var before = collapse(text[start..<at])
        while let first = before.first, first == 0x20 { before.removeFirst() }
        let mid = collapse(text[at..<matchEnd])
        var after = collapse(text[matchEnd..<max(matchEnd, end)])
        while let last = after.last, last == 0x20 { after.removeLast() }
        let snippet = lead + before + mid + after + tail
        return Snippet(
            snippet: String(decoding: snippet, as: UTF8.self),
            matchStart: lead.count + before.count,
            matchLength: mid.count
        )
    }

    /// Searches raw JSON text for a query and returns the best-ranked match.
    /// Used for folder-wide search on files whose root is not an array.
    static func searchText(_ text: [UInt8], query: String) -> TextMatch? {
        let needle = Array(query.lowercased().utf8)
        if needle.isEmpty { return nil }
        guard let found = bestOccurrence(text, needle: needle) else { return nil }
        let snippet = makeSnippet(text, at: found.at, length: needle.count)
        return TextMatch(
            tier: found.tier,
            field: enclosingField(text, at: found.at),
            snippet: snippet.snippet,
            matchStart: snippet.matchStart,
            matchLength: snippet.matchLength
        )
    }
}
