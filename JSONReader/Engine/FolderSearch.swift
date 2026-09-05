import Foundation

/// Folder-level file discovery, mirroring the previous main-process rules.
enum FolderScan {
    /// Top-level `.json` files of `folder` (dotfiles skipped), sorted by name.
    /// Throws `JsonError` when the folder cannot be read.
    static func listJsonFiles(in folder: String) throws -> [String] {
        let manager = FileManager.default
        let entries: [String]
        do {
            entries = try manager.contentsOfDirectory(atPath: folder)
        } catch {
            throw JsonError(message: "The folder could not be read.")
        }
        return entries
            .filter { name in
                guard !name.hasPrefix("."), name.lowercased().hasSuffix(".json") else { return false }
                var isDirectory: ObjCBool = false
                let path = (folder as NSString).appendingPathComponent(name)
                return manager.fileExists(atPath: path, isDirectory: &isDirectory) && !isDirectory.boolValue
            }
            .sorted { $0.localizedCompare($1) == .orderedAscending }
    }
}

enum FolderSearchOutcome: Equatable, Sendable {
    case ok(hits: [SearchHit], moreAvailable: Bool)
    case canceled
    case unsupported
}

/// Folder-wide search. Keeps one entry per file so repeated queries reuse the
/// open file (its handle, element ranges, and search memo) instead of
/// re-analyzing every file on each keystroke. Entries are dropped — closing
/// any open file handles — whenever the folder changes.
actor FolderSearcher {
    private struct Entry {
        var file: JsonFile?
        var text: [UInt8]?
    }

    static let folderSearchLimit = 10

    private var cache: [String: Entry] = [:]

    func clear() async {
        let entries = Array(cache.values)
        cache.removeAll()
        for entry in entries {
            await entry.file?.close()
        }
    }

    /// Searches `files` (absolute paths, in folder order). Hits carry the
    /// file's index and display name. Returns `.canceled` as soon as
    /// `isCanceled` reports true.
    func search(_ query: String, files: [String], isCanceled: @Sendable () -> Bool) async -> FolderSearchOutcome {
        if files.isEmpty { return .unsupported }
        var hits: [SearchHit] = []
        var moreAvailable = false

        func addHit(_ hit: SearchHit) {
            var slot = hits.count
            while slot > 0, hits[slot - 1].tier > hit.tier { slot -= 1 }
            if hits.count < Self.folderSearchLimit {
                hits.insert(hit, at: slot)
            } else if slot < Self.folderSearchLimit {
                hits.insert(hit, at: slot)
                hits.removeLast()
                moreAvailable = true
            } else {
                moreAvailable = true
            }
        }

        for (fileIndex, path) in files.enumerated() {
            if isCanceled() { return .canceled }
            let fileName = (path as NSString).lastPathComponent

            // Reuse the entry from previous searches so array roots keep their
            // handle, element ranges, and search memo (incremental search), and
            // non-array roots keep their raw text (no second read per query).
            var entry = cache[path] ?? Entry()
            if cache[path] == nil {
                if let file = try? await JsonFile.open(path: path) {
                    if await file.searchable {
                        entry.file = file
                    } else {
                        await file.close()
                    }
                }
                if entry.file == nil {
                    // Unreadable or malformed files stay cached as empty entries
                    // so this folder's searches do not retry them on every query.
                    if let data = FileManager.default.contents(atPath: path) {
                        entry.text = [UInt8](data)
                    }
                }
                cache[path] = entry
            }

            if let file = entry.file {
                guard let result = try? await file.search(query, isCanceled: isCanceled) else {
                    if isCanceled() { return .canceled }
                    continue
                }
                // A single file can hold more matches than the folder cap reports;
                // its flag is the only way those extra matches become visible.
                moreAvailable = moreAvailable || result.moreAvailable
                for hit in result.hits {
                    addHit(SearchHit(base: hit, fileIndex: fileIndex, fileName: fileName))
                }
            } else if let text = entry.text, let found = RawJsonSearch.searchText(text, query: query) {
                let base = SearchHitBase(
                    index: 0,
                    tier: found.tier,
                    field: found.field,
                    snippet: found.snippet,
                    matchStart: found.matchStart,
                    matchLength: found.matchLength
                )
                addHit(SearchHit(base: base, fileIndex: fileIndex, fileName: fileName))
            }
        }

        return .ok(hits: hits, moreAvailable: moreAvailable)
    }
}
