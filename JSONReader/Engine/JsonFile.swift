import Foundation

/// What the root of an opened file is.
enum RootInfo: Equatable, Sendable {
    /// The root is an array whose elements are read on demand.
    case array(count: Int)
    /// Any other root value, parsed in full.
    case value(JsonValue)
}

struct SearchResult: Equatable, Sendable {
    var hits: [SearchHitBase]
    var moreAvailable: Bool
}

/// Provides access to a JSON file without materializing all of it.
///
/// When the root of the document is an array, opening the file only records
/// the byte range of every top-level element; each element is then read and
/// parsed individually by `item(_:)`. This keeps both the memory footprint and
/// the cost of navigating between items low, even for files with hundreds of
/// thousands of elements. Any other root value is parsed in full up front.
actor JsonFile {
    let path: String

    private var handle: FileHandle?
    private var starts: [Int] = []
    private var ends: [Int] = []
    private var rootValue: JsonValue = .null
    private var rootIsArray = false

    private struct SearchMemo {
        var query: [UInt8]
        var indices: [Int]
        var moreAvailable: Bool
    }
    private var searchMemo: SearchMemo?

    /// Root values that are not arrays must fit in memory; array roots never do.
    static let maxSingleValueBytes = 256 * 1024 * 1024
    static let searchLimit = 10
    static let defaultChunkSize = 1 << 20

    private init(path: String) {
        self.path = path
    }

    deinit {
        try? handle?.close()
    }

    static func open(path: String, chunkSize: Int = JsonFile.defaultChunkSize) async throws -> JsonFile {
        let file = JsonFile(path: path)
        try await file.analyze(chunkSize: chunkSize)
        return file
    }

    var root: RootInfo {
        rootIsArray ? .array(count: starts.count) : .value(rootValue)
    }

    /// Search is only meaningful for array roots.
    var searchable: Bool { rootIsArray }

    var count: Int { starts.count }

    func close() {
        guard let handle else { return }
        self.handle = nil
        try? handle.close()
    }

    // MARK: - Opening

    private func analyze(chunkSize: Int) async throws {
        var isDirectory: ObjCBool = false
        if FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory), isDirectory.boolValue {
            throw JsonError(message: "That path is a folder, not a file.")
        }
        let opened: FileHandle
        do {
            opened = try FileHandle(forReadingFrom: URL(fileURLWithPath: path))
        } catch {
            throw Self.readError(error)
        }
        handle = opened
        do {
            let size = Int(try opened.seekToEnd())
            let result = try JsonScanner.scan(handle: opened, size: size, chunkSize: chunkSize)
            starts = result.starts
            ends = result.ends
            if result.rootIsArray {
                rootIsArray = true
                return
            }
            if size > Self.maxSingleValueBytes {
                throw JsonError(message: "This file is too large to open. Only files whose root is a JSON array can be this big.")
            }
            rootValue = try Self.parseWhole(opened, size: size)
            close()
        } catch {
            close()
            throw error
        }
    }

    private static func readError(_ error: Error) -> JsonError {
        let nsError = error as NSError
        if nsError.domain == NSCocoaErrorDomain {
            switch CocoaError.Code(rawValue: nsError.code) {
            case .fileNoSuchFile, .fileReadNoSuchFile:
                return JsonError(message: "The file could not be found.")
            case .fileReadNoPermission:
                return JsonError(message: "The file could not be read (permission denied).")
            default:
                break
            }
        }
        if nsError.domain == NSPOSIXErrorDomain {
            switch Int32(nsError.code) {
            case ENOENT: return JsonError(message: "The file could not be found.")
            case EACCES, EPERM: return JsonError(message: "The file could not be read (permission denied).")
            case EISDIR: return JsonError(message: "That path is a folder, not a file.")
            default: break
            }
        }
        return JsonError(message: "The file could not be read.")
    }

    private static func parseWhole(_ handle: FileHandle, size: Int) throws -> JsonValue {
        try handle.seek(toOffset: 0)
        var data = try handle.readToEnd() ?? Data()
        if data.count >= 3, data[data.startIndex] == 0xEF, data[data.startIndex + 1] == 0xBB, data[data.startIndex + 2] == 0xBF {
            data = data.dropFirst(3)
        }
        return try JsonValueParser.parse(String(decoding: data, as: UTF8.self))
    }

    // MARK: - Items

    func item(_ index: Int) throws -> JsonValue {
        guard rootIsArray, handle != nil else { throw JsonError(message: "The file is no longer open.") }
        guard index >= 0, index < starts.count else { throw JsonError(message: "The item index is out of range.") }
        let bytes = try readSlice(start: starts[index], end: ends[index])
        do {
            return try JsonValueParser.parse(String(decoding: bytes, as: UTF8.self))
        } catch let error as JsonError {
            throw JsonError(message: "Item \(index + 1) is not valid JSON: \(error.message)")
        }
    }

    private func readSlice(start: Int, end: Int) throws -> [UInt8] {
        guard let handle else { throw JsonError(message: "The file is no longer open.") }
        let length = end - start
        var buffer: [UInt8] = []
        buffer.reserveCapacity(length)
        try handle.seek(toOffset: UInt64(start))
        while buffer.count < length {
            guard let data = try handle.read(upToCount: length - buffer.count), !data.isEmpty else {
                throw JsonError(message: "The file ended unexpectedly while reading an item.")
            }
            buffer.append(contentsOf: data)
        }
        return buffer
    }

    // MARK: - Search

    /// Case-insensitively searches every element's raw text for `query` and
    /// returns up to ten hits ranked by match quality (exact string values
    /// first, then value prefixes, then any occurrence). Elements are read one
    /// at a time via their byte ranges, so nothing is materialized up front.
    ///
    /// Returns nil when the scan was canceled through `isCanceled`. When the
    /// query extends the previous one, the previous hits are re-verified
    /// first, which usually avoids a second pass over large files.
    func search(_ query: String, isCanceled: () -> Bool = { Task.isCancelled }) async throws -> SearchResult? {
        guard rootIsArray, handle != nil else { throw JsonError(message: "Search needs an open JSON array file.") }
        let needle = Array(query.lowercased().utf8)
        if needle.isEmpty { return SearchResult(hits: [], moreAvailable: false) }

        // A longer query can only match inside the previous query's matches, so
        // when the previous scan was complete its indices are every candidate
        // and re-verifying them is exact. A memo that dropped matches (its scan
        // hit the limit) is incomplete: the new query's best-ranked hits may
        // live in elements it never kept, so a full scan must run instead.
        if let memo = searchMemo, needle.starts(with: memo.query), !memo.moreAvailable {
            var verified: [SearchHitBase] = []
            for index in memo.indices {
                if isCanceled() { return nil }
                let text = try readSlice(start: starts[index], end: ends[index])
                // Rank occurrences exactly like the full scan does so both paths
                // agree on tier and snippet for the same element.
                guard let found = RawJsonSearch.bestOccurrence(text, needle: needle) else { continue }
                verified.append(Self.makeHit(index: index, text: text, found: found, needleLength: needle.count))
            }
            // The memo is complete, so verified holds every match; order it like
            // the full scan would (tier first, then element order) and memo the
            // narrowed result so the next keystroke narrows from it.
            verified.sort { $0.tier != $1.tier ? $0.tier < $1.tier : $0.index < $1.index }
            searchMemo = SearchMemo(query: needle, indices: verified.map(\.index), moreAvailable: false)
            return SearchResult(hits: verified, moreAvailable: false)
        }

        struct Pick {
            var index: Int
            var tier: SearchTier
            var at: Int
        }
        var picks: [Pick] = []
        var dropped = false
        var scannedAll = true

        for i in 0..<starts.count {
            if isCanceled() { return nil }
            if i % 512 == 511 { await Task.yield() }
            let text = try readSlice(start: starts[i], end: ends[i])
            guard let found = RawJsonSearch.bestOccurrence(text, needle: needle) else { continue }
            // Picks are collected in index order; keep the list sorted by tier so
            // the best ten survive regardless of where they were found.
            var slot = picks.count
            while slot > 0, picks[slot - 1].tier > found.tier { slot -= 1 }
            if picks.count < Self.searchLimit {
                picks.insert(Pick(index: i, tier: found.tier, at: found.at), at: slot)
            } else if slot < Self.searchLimit {
                picks.insert(Pick(index: i, tier: found.tier, at: found.at), at: slot)
                picks.removeLast()
                dropped = true
            } else {
                dropped = true
            }
            // Ten exact matches cannot be outranked by anything later in the file.
            if picks.count == Self.searchLimit, picks[Self.searchLimit - 1].tier == 1 {
                if i < starts.count - 1 { scannedAll = false }
                break
            }
        }

        var hits: [SearchHitBase] = []
        hits.reserveCapacity(picks.count)
        for pick in picks {
            let text = try readSlice(start: starts[pick.index], end: ends[pick.index])
            let found = RawJsonSearch.Occurrence(tier: pick.tier, at: pick.at)
            hits.append(Self.makeHit(index: pick.index, text: text, found: found, needleLength: needle.count))
        }
        let moreAvailable = dropped || !scannedAll
        searchMemo = SearchMemo(query: needle, indices: picks.map(\.index), moreAvailable: moreAvailable)
        return SearchResult(hits: hits, moreAvailable: moreAvailable)
    }

    private static func makeHit(index: Int, text: [UInt8], found: RawJsonSearch.Occurrence, needleLength: Int) -> SearchHitBase {
        let snippet = RawJsonSearch.makeSnippet(text, at: found.at, length: needleLength)
        return SearchHitBase(
            index: index,
            tier: found.tier,
            field: RawJsonSearch.enclosingField(text, at: found.at),
            snippet: snippet.snippet,
            matchStart: snippet.matchStart,
            matchLength: snippet.matchLength
        )
    }
}
