import Foundation
import Testing
@testable import JSONReader

@MainActor
@Suite("CommentStore")
struct CommentStoreTests {
    let dir = try! FixtureDirectory("json-reader-comments")
    private var storeDirectory: URL { dir.url.appendingPathComponent("stores") }

    private func makeStore() -> CommentStore {
        CommentStore(directory: storeDirectory)
    }

    @Test func storesPerFileUnderDistinctHashedNames() {
        let a = CommentStore.storeURL(for: "/tmp/a.json", in: storeDirectory)
        let b = CommentStore.storeURL(for: "/tmp/b.json", in: storeDirectory)
        let sameA = CommentStore.storeURL(for: "/tmp/a.json", in: storeDirectory)
        #expect(a != b, "two JSON files must never share one comments store")
        #expect(a == sameA)
        #expect(a.lastPathComponent.hasSuffix(".json"))
    }

    @Test func upsertPersistsImmediatelyAndSurvivesReload() async throws {
        let file = try dir.file("doc.json", "[{\"word\": \"apple\"}]")
        let store = makeStore()
        store.load(filePath: file)
        store.upsert(pointer: "/0/word", text: "Check this value")
        #expect(store.comment(at: "/0/word")?.text == "Check this value")

        // A fresh instance reads the same comment back from disk.
        let reopened = makeStore()
        reopened.load(filePath: file)
        #expect(reopened.comment(at: "/0/word")?.text == "Check this value")
        #expect(reopened.comment(at: "/0/word")?.pointer == "/0/word")
    }

    @Test func editUpdatesTextAndTimestamp() async throws {
        let file = try dir.file("edit.json", "{}")
        let store = makeStore()
        store.load(filePath: file)
        store.upsert(pointer: "", text: "first")
        let created = store.comment(at: "")
        // Wait so updatedAt can differ from createdAt.
        try await Task.sleep(for: .milliseconds(20))
        store.upsert(pointer: "", text: "second")
        let edited = store.comment(at: "")
        #expect(edited?.text == "second")
        #expect(edited?.createdAt == created?.createdAt)
        #expect(try #require(edited?.updatedAt).timeIntervalSince(try #require(created?.createdAt)) > 0)
    }

    @Test func commentsOfDifferentFilesNeverMix() throws {
        let a = try dir.file("a.json", "[1]")
        let b = try dir.file("b.json", "[2]")
        let store = makeStore()
        store.load(filePath: a)
        store.upsert(pointer: "/0", text: "belongs to a")
        store.load(filePath: b)
        #expect(store.comment(at: "/0") == nil)
        store.load(filePath: a)
        #expect(store.comment(at: "/0")?.text == "belongs to a")
    }

    @Test func deletingLastCommentRemovesTheStoreFile() throws {
        let file = try dir.file("cleanup.json", "[1]")
        let store = makeStore()
        store.load(filePath: file)
        store.upsert(pointer: "/0", text: "temporary")
        let url = CommentStore.storeURL(for: file, in: storeDirectory)
        #expect(FileManager.default.fileExists(atPath: url.path))
        store.remove(pointer: "/0")
        #expect(!FileManager.default.fileExists(atPath: url.path))
    }

    @Test func removeOnlyDropsTheTargetComment() throws {
        let file = try dir.file("multi.json", "{\"a\": 1, \"b\": 2}")
        let store = makeStore()
        store.load(filePath: file)
        store.upsert(pointer: "/a", text: "keep")
        store.upsert(pointer: "/b", text: "drop")
        store.remove(pointer: "/b")
        #expect(store.comment(at: "/a") != nil)
        #expect(store.comment(at: "/b") == nil)
    }

    @Test func unloadDropsEverythingWithoutPersisting() throws {
        let file = try dir.file("unload.json", "[1]")
        let store = makeStore()
        store.load(filePath: file)
        store.upsert(pointer: "/0", text: "saved")
        store.upsert(pointer: "/0", text: "changed after save")
        // The changed-but-persisted state is on disk already; unload only
        // clears memory, so the saved text must still be there.
        store.unload()
        #expect(store.comment(at: "/0") == nil)
        let reopened = makeStore()
        reopened.load(filePath: file)
        #expect(reopened.comment(at: "/0")?.text == "changed after save")
    }

    @Test func reconcilesAgainstTheOpenFile() async throws {
        let file = try dir.file("reconcile.json", "[{\"keep\": true}, {\"keep\": true}, {\"other\": false}]")
        let store = makeStore()
        store.load(filePath: file)
        store.upsert(pointer: "/0/keep", text: "exists")
        store.upsert(pointer: "/2/gone", text: "will be deleted with its entity")
        store.upsert(pointer: "/2/nope", text: "never existed")
        store.upsert(pointer: "/9", text: "out of range")

        let jsonFile = try await JsonFile.open(path: file)
        await store.reconcile(with: jsonFile, filePath: file)
        #expect(store.comment(at: "/0/keep") != nil)
        #expect(store.comment(at: "/2/gone") == nil)
        #expect(store.comment(at: "/2/nope") == nil)
        #expect(store.comment(at: "/9") == nil)
    }

    @Test func reconcileIsIgnoredAfterSwitchingFiles() async throws {
        let target = try dir.file("switch-target.json", "[{\"a\": 1}]")
        let other = try dir.file("switch-other.json", "[{\"b\": 2}]")
        let store = makeStore()
        store.load(filePath: target)
        store.upsert(pointer: "/0/a", text: "note")

        // The user switches to another file before the scan comes back.
        let jsonFile = try await JsonFile.open(path: target)
        store.load(filePath: other)
        await store.reconcile(with: jsonFile, filePath: target)
        #expect(store.comment(at: "/0/a") == nil, "the other file has no comment at /0/a")
        // …and the stale scan must not have written anything either.
        let reopened = makeStore()
        reopened.load(filePath: target)
        #expect(reopened.comment(at: "/0/a")?.text == "note")
    }
}

@Suite("CommentReconciler")
struct CommentReconcilerTests {
    let dir = try! FixtureDirectory("json-reader-reconciler")

    @Test func valueRootStaleAndLivePointers() async throws {
        let file = try await JsonFile.open(path: try dir.file("value.json", #"{"a": {"b": [10, 20]}, "s": "x"}"#))
        let stale = await CommentReconciler.stalePointers(["", "/a", "/a/b/1", "/a/b/5", "/missing", "/a/x"], in: file)
        #expect(Set(stale) == ["/a/b/5", "/missing", "/a/x"])
    }

    @Test func arrayRootChecksOnlyTheReferencedItems() async throws {
        let path = try dir.file("array.json", "[{\"n\": 1}, {\"n\": 2}, {\"n\": 3}]")
        let file = try await JsonFile.open(path: path)
        let stale = await CommentReconciler.stalePointers(["/0", "/0/n", "/2/n", "/3", "/x", "/01/n"], in: file)
        #expect(Set(stale) == ["/3", "/x", "/01/n"])
    }

    @Test func bigArrayRootOnlyParsesReferencedItems() async throws {
        let items = (0..<5000).map { "{\"id\": \($0)}" }
        let file = try await JsonFile.open(path: try dir.file("big.json", "[" + items.joined(separator: ",") + "]"))
        let started = Date()
        let stale = await CommentReconciler.stalePointers(["/0/id", "/4999/id", "/4999/missing", "/5000"], in: file)
        #expect(Set(stale) == ["/4999/missing", "/5000"])
        #expect(Date().timeIntervalSince(started) < 5)
    }

    @Test func keepsCommentsWhenAnItemCannotBeParsed() async throws {
        // The trailing element scans as a valid container (so the file
        // opens) but fails to parse when read: the scan must keep (not
        // delete) comments pointing into it.
        let path = try dir.file("broken-item.json", "[{\"n\": 1}, {\"bad\": }]")
        let file = try await JsonFile.open(path: path)
        let stale = await CommentReconciler.stalePointers(["/1/n", "/0/n"], in: file)
        #expect(stale.isEmpty)
    }
}

/// The full cascade story: comment a node, remove the node from the file on
/// disk, reopen, and the comment is gone — while a comment on a surviving
/// node stays.
@MainActor
@Suite("Entity deletion cascades to comments")
struct CommentCascadeTests {
    let dir = try! FixtureDirectory("json-reader-cascade")

    private func model() -> AppModel {
        AppModel(commentsDirectory: dir.url.appendingPathComponent("stores"))
    }

    @Test func removingAnEntityDeletesItsComment() async throws {
        let file = try dir.file("cascade.json", "[{\"id\": 1, \"tag\": \"keep\"}, {\"id\": 2, \"tag\": \"drop\"}]")
        let app = model()
        _ = await app.openJsonFile(file)
        await app.awaitPendingReconciles()
        app.comments.upsert(pointer: "/0/tag", text: "survivor")
        app.comments.upsert(pointer: "/1/tag", text: "doomed")
        #expect(app.comments.hasComments)

        // The entity at /1 (item 2) is deleted from the file on disk.
        try "[{\"id\": 1, \"tag\": \"keep\"}]".write(toFile: file, atomically: true, encoding: .utf8)

        // Reopening the file loads the changed content and reconciles.
        let reopened = model()
        _ = await reopened.openJsonFile(file)
        await reopened.awaitPendingReconciles()
        #expect(reopened.comments.comment(at: "/0/tag")?.text == "survivor")
        #expect(reopened.comments.comment(at: "/1/tag") == nil)

        // The deletion was persisted, not just in memory.
        let onDisk = model()
        _ = await onDisk.openJsonFile(file)
        await onDisk.awaitPendingReconciles()
        #expect(onDisk.comments.comment(at: "/1/tag") == nil)
        #expect(onDisk.comments.comment(at: "/0/tag")?.text == "survivor")
    }

    @Test func editingTheFileInTheEditorKeepsUnrelatedComments() async throws {
        let file = try dir.file("stable.json", "{\"word\": \"apple\"}")
        let app = model()
        _ = await app.openJsonFile(file)
        await app.awaitPendingReconciles()
        app.comments.upsert(pointer: "/word", text: "nice word")
        // The file changes but the commented node stays.
        try #"{"word": "pear"}"#.write(toFile: file, atomically: true, encoding: .utf8)
        let reopened = model()
        _ = await reopened.openJsonFile(file)
        await reopened.awaitPendingReconciles()
        #expect(reopened.comments.comment(at: "/word")?.text == "nice word")
    }
}
