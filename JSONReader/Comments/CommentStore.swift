import CryptoKit
import Foundation
import Observation

/// One user comment attached to a JSON entity (node) of one file.
/// `pointer` is the RFC 6901 JSON Pointer from the document root, so it
/// keeps working across sessions without the app running.
struct EntityComment: Codable, Equatable, Identifiable, Sendable {
    var id: UUID
    var pointer: String
    var text: String
    var createdAt: Date
    var updatedAt: Date

    init(pointer: String, text: String, id: UUID = UUID(), createdAt: Date = .now, updatedAt: Date = .now) {
        self.id = id
        self.pointer = pointer
        self.text = text
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

/// The editor request for one pointer: nothing exists yet for a new comment,
/// or the stored comment when editing.
struct CommentEditing: Identifiable, Equatable {
    var pointer: String
    var existing: EntityComment?

    var id: String { pointer }
}

/// The persisted shape of one file's comments. Every JSON file gets its own
/// store file — two files never share one.
private struct StoredComments: Codable {
    var version: Int
    var file: String
    var comments: [EntityComment]
}

/// Comments for the currently open JSON file, held in memory and persisted
/// immediately on every change to
/// `~/Library/Application Support/com.z1joey.json-reader/comments/<sha256(path)>.json`.
///
/// The filename hashes the file's absolute path, so comments follow their
/// file across folders (as long as the path stays the same) and two files
/// can never collide on one store.
@MainActor
@Observable
final class CommentStore {
    /// Pointer-keyed comments of the current file.
    private(set) var comments: [String: EntityComment] = [:]
    /// The path of the file these comments belong to (nil = no file open).
    private(set) var filePath: String?
    /// Presenting an editor for this pointer, when set.
    var editing: CommentEditing?
    /// The last persistence failure, for an alert.
    var lastError: String?

    private let directory: URL

    init(directory: URL = CommentStore.defaultDirectory) {
        self.directory = directory
    }

    nonisolated static let defaultDirectory: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("com.z1joey.json-reader/comments", isDirectory: true)
    }()

    /// The store file for `filePath`: its SHA-256 path hash, so different
    /// files (and files with the same name in different folders) never share
    /// one comments file.
    static func storeURL(for filePath: String, in directory: URL) -> URL {
        let digest = SHA256.hash(data: Data(filePath.utf8))
        let hex = digest.map { String(format: "%02x", $0) }.joined()
        return directory.appendingPathComponent("\(hex).json")
    }

    // MARK: - Loading

    /// Replaces the in-memory comments with the ones stored for `filePath`.
    func load(filePath: String) {
        self.filePath = filePath
        editing = nil
        do {
            comments = try Self.readComments(for: filePath, in: directory)
        } catch {
            comments = [:]
            lastError = error.localizedDescription
        }
    }

    /// Drops the in-memory comments (nothing is persisted).
    func unload() {
        filePath = nil
        comments = [:]
        editing = nil
    }

    private static func readComments(for filePath: String, in directory: URL) throws -> [String: EntityComment] {
        let url = storeURL(for: filePath, in: directory)
        guard FileManager.default.fileExists(atPath: url.path) else { return [:] }
        let data = try Data(contentsOf: url)
        let stored = try JSONDecoder().decodeWithDateDecodingStrategy(StoredComments.self, from: data)
        guard stored.file == filePath else {
            // The hash names the file; a mismatch means the store is corrupt.
            throw JsonError(message: "The comments file for this JSON file is corrupt.")
        }
        return Dictionary(uniqueKeysWithValues: stored.comments.map { ($0.pointer, $0) })
    }

    // MARK: - Reading

    func comment(at pointer: String) -> EntityComment? {
        comments[pointer]
    }

    var hasComments: Bool { !comments.isEmpty }

    // MARK: - Editing

    func beginEditing(_ pointer: String) {
        editing = CommentEditing(pointer: pointer, existing: comments[pointer])
    }

    /// Creates or updates the comment at `pointer` and persists immediately.
    func upsert(pointer: String, text: String) {
        guard filePath != nil else { return }
        if var existing = comments[pointer] {
            existing.text = text
            existing.updatedAt = .now
            comments[pointer] = existing
        } else {
            comments[pointer] = EntityComment(pointer: pointer, text: text)
        }
        persist()
    }

    /// Deletes the comment at `pointer` and persists immediately.
    func remove(pointer: String) {
        guard comments.removeValue(forKey: pointer) != nil else { return }
        persist()
    }

    // MARK: - Cascade deletion

    /// Deletes every comment whose node no longer exists in `file`, then
    /// persists. Called each time a file opens, so a comment whose entity was
    /// removed from the file on disk disappears with it. Removals only apply
    /// while the store still belongs to `filePath` — the user may have
    /// switched files before the scan finishes.
    func reconcile(with file: JsonFile, filePath expected: String) async {
        guard filePath == expected else { return }
        let stale = await CommentReconciler.stalePointers(Array(comments.keys), in: file)
        guard filePath == expected, !stale.isEmpty else { return }
        for pointer in stale {
            comments.removeValue(forKey: pointer)
        }
        persist()
    }

    // MARK: - Persistence

    private func persist() {
        guard let filePath else { return }
        do {
            try Self.write(comments: Array(comments.values), for: filePath, in: directory)
            lastError = nil
        } catch {
            lastError = error.localizedDescription
        }
    }

    private static func write(comments: [EntityComment], for filePath: String, in directory: URL) throws {
        let url = storeURL(for: filePath, in: directory)
        if comments.isEmpty {
            if FileManager.default.fileExists(atPath: url.path) {
                try FileManager.default.removeItem(at: url)
            }
            return
        }
        let stored = StoredComments(version: 1, file: filePath, comments: comments.sorted { $0.pointer < $1.pointer })
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(stored)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try data.write(to: url, options: .atomic)
    }
}

extension JSONDecoder {
    /// The store uses ISO 8601 dates.
    func decodeWithDateDecodingStrategy<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        dateDecodingStrategy = .iso8601
        defer { dateDecodingStrategy = .deferredToDate }
        return try decode(type, from: data)
    }
}

/// Decides which stored comments no longer have a node in the file.
enum CommentReconciler {
    /// For array roots only the referenced items are parsed — one at a time
    /// through their byte ranges — so reconciling stays cheap even for huge
    /// files. Pointers that fail to resolve are reported as stale; pointers
    /// whose item cannot be read at all are kept (the file may be mid-change,
    /// and deleting on a read error would lose notes).
    static func stalePointers(_ pointers: [String], in file: JsonFile) async -> [String] {
        let root = await file.root
        switch root {
        case .value(let value):
            return pointers.filter { JsonPointer.resolve(value, pointer: $0) == nil }
        case .array(let count):
            var perItem: [Int: [String]] = [:]
            var stale: [String] = []
            for pointer in pointers {
                guard let index = Self.leadingArrayIndex(of: pointer), index < count else {
                    if !pointer.isEmpty { stale.append(pointer) }
                    continue
                }
                perItem[index, default: []].append(pointer)
            }
            for (index, group) in perItem {
                guard let item = try? await file.item(index) else { continue }
                for pointer in group {
                    let rest = Self.pointer(afterLeadingIndex: pointer)
                    if JsonPointer.resolve(item, pointer: rest) == nil {
                        stale.append(pointer)
                    }
                }
            }
            return stale
        }
    }

    /// The canonical integer of the first reference token, or nil.
    private static func leadingArrayIndex(of pointer: String) -> Int? {
        guard pointer.hasPrefix("/") else { return nil }
        let token = pointer.dropFirst().prefix { $0 != "/" }
        guard let index = Int(token), token == String(index) else { return nil }
        return index
    }

    /// The pointer with its first reference token removed ("" for "/3").
    private static func pointer(afterLeadingIndex pointer: String) -> String {
        guard pointer.hasPrefix("/") else { return pointer }
        let rest = pointer.dropFirst()
        guard let slash = rest.firstIndex(of: "/") else { return "" }
        return String(rest[slash...])
    }
}
