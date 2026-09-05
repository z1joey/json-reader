import Foundation
import Testing
@testable import JSONReader

@Suite("Folder listing")
struct FolderScanTests {
    let dir = try! FixtureDirectory("json-reader-folder")

    @Test func listsSortedJsonFiles() throws {
        let folder = try dir.folder("multi", ["b.json": "[2]", "a.json": "[1]", "notes.txt": "x", "c.JSON": "[3]"])
        #expect(try FolderScan.listJsonFiles(in: folder) == ["a.json", "b.json", "c.JSON"])
    }

    @Test func skipsDotfilesAndDirectories() throws {
        let folder = try dir.folder("dotted", [".hidden.json": "[]", "a.json": "[]", "b.json": "[]"])
        try FileManager.default.createDirectory(atPath: (folder as NSString).appendingPathComponent("sub.json"), withIntermediateDirectories: true)
        #expect(try FolderScan.listJsonFiles(in: folder) == ["a.json", "b.json"])
    }

    @Test func reportsUnreadableFolder() {
        #expect(throws: JsonError.self) {
            try FolderScan.listJsonFiles(in: dir.url.appendingPathComponent("missing").path)
        }
    }
}

@Suite("Opening folders")
@MainActor
struct OpenFolderTests {
    let dir = try! FixtureDirectory("json-reader-open")

    private func model(picking path: String?) -> AppModel {
        let model = AppModel()
        model.showsOpenPanel = { path }
        return model
    }

    @Test func opensMultiFileFolderWithSidebar() async throws {
        let folder = try dir.folder("multi", ["b.json": "[2]", "a.json": "[1]"])
        let model = model(picking: folder)
        await model.pickFolderAsync()
        #expect(model.folder == FolderState(name: "multi", path: folder, files: ["a.json", "b.json"], activeIndex: 0))
        #expect(model.view == .array(fileName: "a.json", count: 1, index: 0, item: .loading) || model.view == .array(fileName: "a.json", count: 1, index: 0, item: .value(1)))
    }

    @Test func suggestsAnotherFolderWhenNoJsonFiles() async throws {
        let folder = try dir.folder("empty", ["readme.txt": "nothing here"])
        let model = model(picking: folder)
        await model.pickFolderAsync()
        #expect(model.folder == nil)
        #expect(model.view == .error(fileName: "empty", message: "No JSON files found in this folder. Please choose another folder."))
    }

    @Test func opensLoneJsonFileDirectly() async throws {
        let folder = try dir.folder("lone", ["only.json": "[1, 2]"])
        let model = model(picking: folder)
        await model.pickFolderAsync()
        #expect(model.folder == nil)
        guard case .array(let fileName, let count, let index, _) = model.view else {
            Issue.record("expected array view, got \(model.view)")
            return
        }
        #expect(fileName == "only.json")
        #expect(count == 2)
        #expect(index == 0)
        // No folder was recorded, so index-based opening is unavailable.
        await model.loadFolderFile(0)
        #expect(model.view == .error(fileName: "", message: "No folder is open."))
    }

    @Test func loadsListedFileByIndex() async throws {
        let folder = try dir.folder("indexed", ["a.json": "{\"x\": 1}", "b.json": "{\"y\": 2}"])
        let model = model(picking: folder)
        await model.pickFolderAsync()
        await model.loadFolderFile(1)
        #expect(model.view == .value(fileName: "b.json", value: ["y": 2]))
        #expect(model.folder?.activeIndex == 1)
    }

    @Test func canceledDialogChangesNothing() async throws {
        let model = model(picking: nil)
        await model.pickFolderAsync()
        #expect(model.view == .empty)
        #expect(model.folder == nil)
    }

    @Test func openingAnItemAfterFileLoads() async throws {
        let folder = try dir.folder("items", ["a.json": "[{\"n\": 1}, {\"n\": 2}, {\"n\": 3}]", "b.json": "[1]"])
        let model = model(picking: folder)
        await model.pickFolderAsync()
        await model.loadFolderFile(0, itemIndex: 2)
        guard case .array(_, let count, let index, _) = model.view else {
            Issue.record("expected array view")
            return
        }
        #expect(count == 3)
        #expect(index == 2)
        // The item arrives asynchronously; wait briefly for it.
        for _ in 0..<50 {
            if case .array(_, _, _, .value(let value)) = model.view {
                #expect(value == ["n": 3])
                return
            }
            try await Task.sleep(for: .milliseconds(20))
        }
        Issue.record("item never loaded: \(model.view)")
    }

    @Test func searchesAcrossFolderFiles() async throws {
        let folder = try dir.folder("search-folder", [
            "a.json": #"[{"word": "apple"}]"#,
            "b.json": #"[{"word": "banana"}]"#,
            "c.json": #"{"note": "apple pie"}"#
        ])
        let model = model(picking: folder)
        await model.pickFolderAsync()
        guard case .ok(let hits, _) = await model.search("apple") else {
            Issue.record("search failed")
            return
        }
        #expect(hits.count >= 2)
        let files = hits.map(\.fileName)
        #expect(files.contains("a.json"))
        #expect(files.contains("c.json"))
        for hit in hits {
            #expect(hit.fileIndex >= 0)
            #expect(!hit.fileName.isEmpty)
        }
    }

    @Test func folderHitsCarryFileIdentity() async throws {
        let folder = try dir.folder("search-array", [
            "a.json": #"[{"word": "one"}]"#,
            "b.json": #"[{"word": "apple"}, {"word": "apple pie"}]"#
        ])
        let model = model(picking: folder)
        await model.pickFolderAsync()
        guard case .ok(let hits, _) = await model.search("apple") else {
            Issue.record("search failed")
            return
        }
        let bHits = hits.filter { $0.fileName == "b.json" }
        #expect(bHits.count == 2)
        #expect(bHits.first?.fileIndex == 1)
        #expect(bHits.map(\.tier) == [1, 2])
    }

    @Test func reportsMoreWhenOneFileExceedsLimit() async throws {
        let many = (0..<15).map { _ in #"{"word": "apple"}"# }.joined(separator: ",")
        let folder = try dir.folder("search-more", ["many.json": "[\(many)]", "none.json": #"[{"word": "banana"}]"#])
        let model = model(picking: folder)
        await model.pickFolderAsync()
        guard case .ok(let hits, let moreAvailable) = await model.search("apple") else {
            Issue.record("search failed")
            return
        }
        #expect(hits.count == 10)
        #expect(moreAvailable == true)
    }

    @Test func searchesCurrentFileWithoutFolder() async throws {
        let folder = try dir.folder("single-search", ["only.json": #"[{"w": "fig"}, {"w": "apple"}]"#])
        let model = model(picking: folder)
        await model.pickFolderAsync()
        guard case .ok(let hits, let moreAvailable) = await model.search("apple") else {
            Issue.record("search failed")
            return
        }
        #expect(hits.map(\.index) == [1])
        #expect(hits.first?.fileName == "only.json")
        #expect(moreAvailable == false)
    }

    @Test func reportsUnsupportedForValueRootWithoutFolder() async throws {
        let folder = try dir.folder("single-value", ["only.json": #"{"w": "apple"}"#])
        let model = model(picking: folder)
        await model.pickFolderAsync()
        #expect(await model.search("apple") == .unsupported)
    }
}

@Suite("Folder search cache")
struct FolderSearcherTests {
    let dir = try! FixtureDirectory("json-reader-cache")

    @Test func cancelsThroughCallback() async throws {
        let folder = try dir.folder("cancel", ["a.json": #"[{"word": "apple"}]"#])
        let searcher = FolderSearcher()
        let outcome = await searcher.search("apple", files: [(folder as NSString).appendingPathComponent("a.json")], isCanceled: { true })
        #expect(outcome == .canceled)
    }

    @Test func keepsAnalyzedArrayFilesWarm() async throws {
        let folder = try dir.folder("warm-array", [
            "a.json": #"[{"word": "apple"}, {"word": "apple pie"}]"#,
            "b.json": #"[{"word": "banana"}]"#
        ])
        let files = ["a.json", "b.json"].map { (folder as NSString).appendingPathComponent($0) }
        let searcher = FolderSearcher()
        guard case .ok = await searcher.search("apple", files: files, isCanceled: { false }) else {
            Issue.record("first search failed")
            return
        }
        // Deleting the file proves the second query does not reopen it: the
        // cached entry keeps serving from its still-open handle.
        try FileManager.default.removeItem(atPath: files[0])
        guard case .ok(let hits, _) = await searcher.search("apple", files: files, isCanceled: { false }) else {
            Issue.record("second search failed")
            return
        }
        #expect(hits.map(\.fileName).contains("a.json"))
    }

    @Test func cachesNonArrayFileText() async throws {
        let folder = try dir.folder("warm-text", [
            "c.json": #"{"note": "apple pie"}"#,
            "d.json": #"[{"word": "banana"}]"#
        ])
        let files = ["c.json", "d.json"].map { (folder as NSString).appendingPathComponent($0) }
        let searcher = FolderSearcher()
        guard case .ok(let first, _) = await searcher.search("apple", files: files, isCanceled: { false }) else {
            Issue.record("first search failed")
            return
        }
        #expect(first.contains { $0.fileName == "c.json" })
        try FileManager.default.removeItem(atPath: files[0])
        guard case .ok(let second, _) = await searcher.search("apple", files: files, isCanceled: { false }) else {
            Issue.record("second search failed")
            return
        }
        #expect(second.contains { $0.fileName == "c.json" })
    }

    @Test func clearDropsCachedEntries() async throws {
        let folder = try dir.folder("clear", ["c.json": #"{"note": "apple pie"}"#])
        let files = [(folder as NSString).appendingPathComponent("c.json")]
        let searcher = FolderSearcher()
        _ = await searcher.search("apple", files: files, isCanceled: { false })
        await searcher.clear()
        try FileManager.default.removeItem(atPath: files[0])
        guard case .ok(let hits, _) = await searcher.search("apple", files: files, isCanceled: { false }) else {
            Issue.record("search failed")
            return
        }
        #expect(hits.isEmpty)
    }
}
