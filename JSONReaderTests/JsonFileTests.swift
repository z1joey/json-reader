import Foundation
import Testing
@testable import JSONReader

@Suite("JsonFile array roots")
struct ArrayRootTests {
    let dir = try! FixtureDirectory("json-reader-array")

    @Test func indexesObjectsAndParsesOnDemand() async throws {
        let path = try dir.file("objects.json", "[\n  {\"id\": 1, \"word\": \"apple\"},\n  {\"id\": 2, \"word\": \"fig\"}\n]")
        let file = try await JsonFile.open(path: path)
        #expect(await file.root == .array(count: 2))
        #expect(try await file.item(0) == ["id": 1, "word": "apple"])
        #expect(try await file.item(1) == ["id": 2, "word": "fig"])
        await file.close()
    }

    @Test func indexesPrimitives() async throws {
        let path = try dir.file("primitives.json", "[\"a\", 1, true, null, -2.5e3, 0]")
        let file = try await JsonFile.open(path: path)
        #expect(await file.root == .array(count: 6))
        #expect(try await file.item(0) == "a")
        #expect(try await file.item(1) == 1)
        #expect(try await file.item(2) == true)
        #expect(try await file.item(3) == nil)
        #expect(try await file.item(4) == -2500)
        #expect(try await file.item(5) == 0)
    }

    @Test func indexesNestedContainersAndBracketStrings() async throws {
        let path = try dir.file("nested.json", "[{\"a\": \"}]{[\", \"b\": [1, {\"c\": \"[\"}]}, [\"x\"]]")
        let file = try await JsonFile.open(path: path)
        #expect(await file.root == .array(count: 2))
        #expect(try await file.item(0) == ["a": "}]{[", "b": [1, ["c": "["]]])
        #expect(try await file.item(1) == ["x"])
    }

    @Test func reportsZeroForEmptyArray() async throws {
        let file = try await JsonFile.open(path: try dir.file("empty-array.json", "[]"))
        #expect(await file.root == .array(count: 0))
    }

    @Test func handlesEscapedQuotes() async throws {
        let file = try await JsonFile.open(path: try dir.file("escapes.json", #"["say \"hi\"","back\\slash"]"#))
        #expect(await file.root == .array(count: 2))
        #expect(try await file.item(0) == "say \"hi\"")
        #expect(try await file.item(1) == "back\\slash")
    }

    @Test func handlesLeadingBOM() async throws {
        let file = try await JsonFile.open(path: try dir.file("bom.json", "\u{FEFF}[{\"a\": 1}]"))
        #expect(await file.root == .array(count: 1))
        #expect(try await file.item(0) == ["a": 1])
    }

    @Test func keepsOffsetsAcrossChunkBoundariesAndMultibyte() async throws {
        let emoji = "\u{1F34E}"
        let triple = emoji + emoji + emoji
        let path = try dir.file("chunks.json", "[\n  {\"word\": \"\(emoji)\", \"note\": \"\(triple) tail\"},\n  {\"id\": 2}\n]")
        let file = try await JsonFile.open(path: path, chunkSize: 9)
        #expect(await file.root == .array(count: 2))
        #expect(try await file.item(0) == ["word": .string(emoji), "note": .string("\(triple) tail")])
        #expect(try await file.item(1) == ["id": 2])
    }

    @Test func rejectsOutOfRangeIndexes() async throws {
        let file = try await JsonFile.open(path: try dir.file("range.json", "[1, 2, 3]"))
        await #expect(throws: JsonError.self) { try await file.item(-1) }
        await #expect(throws: JsonError.self) { try await file.item(3) }
    }

    @Test func indexesLargeArrayQuickly() async throws {
        let count = 50_000
        var items: [String] = []
        items.reserveCapacity(count)
        for i in 0..<count {
            items.append("  {\"id\": \(i), \"word\": \"word\(i)\", \"definition\": \"A reasonably long definition line for word number \(i).\"}")
        }
        let path = try dir.file("large.json", "[\n" + items.joined(separator: ",\n") + "\n]")
        let started = Date()
        let file = try await JsonFile.open(path: path)
        let elapsed = Date().timeIntervalSince(started)
        #expect(await file.root == .array(count: count))
        if case .object(let members) = try await file.item(0) {
            #expect(members.first?.value == 0)
            #expect(members[1].value == "word0")
        } else {
            Issue.record("first item is not an object")
        }
        #expect(try await file.item(count - 1) == ["id": .number(Double(count - 1)), "word": "word49999", "definition": "A reasonably long definition line for word number 49999."])
        if case .object(let members) = try await file.item(25_000) {
            #expect(members[1].value == "word25000")
        }
        // Loose guard against pathological rescanning: indexing 50k items must be quick.
        #expect(elapsed < 10)
    }
}

@Suite("JsonFile search")
struct SearchTests {
    let dir = try! FixtureDirectory("json-reader-search")

    private func hitIndexes(_ result: SearchResult?) -> [Int] { result?.hits.map(\.index) ?? [] }
    private func hitTiers(_ result: SearchResult?) -> [Int] { result?.hits.map(\.tier) ?? [] }

    @Test func ranksExactAbovePrefixAboveSubstring() async throws {
        let path = try dir.file("search-rank.json", #"[{"word":"fig"},{"word":"apple pie"},{"note":"I like apples a lot"},{"word":"apple"}]"#)
        let file = try await JsonFile.open(path: path)
        let result = try #require(try await file.search("apple"))
        #expect(result.moreAvailable == false)
        #expect(result.hits.map(\.index) == [3, 1, 2])
        #expect(result.hits.map(\.tier) == [1, 2, 3])
        #expect(result.hits.map(\.field) == ["word", "word", "note"])
        for hit in result.hits {
            #expect(hit.matchLength == 5)
            #expect(hit.snippetParts.match.lowercased() == "apple")
        }
    }

    @Test func matchesCaseInsensitively() async throws {
        let file = try await JsonFile.open(path: try dir.file("search-case.json", #"[{"w":"Apple"},{"w":"APPLE"},{"w":"apples"}]"#))
        let result = try await file.search("apple")
        #expect(hitIndexes(result) == [0, 1, 2])
        #expect(hitTiers(result) == [1, 1, 2])
    }

    @Test func respectsLimitAndReportsMore() async throws {
        let items = (0..<25).map { "{\"id\": \($0), \"text\": \"contains apple number \($0)\"}" }
        let file = try await JsonFile.open(path: try dir.file("search-limit.json", "[" + items.joined(separator: ",") + "]"))
        let result = try #require(try await file.search("apple"))
        #expect(result.hits.count == 10)
        #expect(result.moreAvailable == true)
    }

    @Test func stopsEarlyOnceTenExactMatchesFill() async throws {
        let items = (0..<40).map { i in i < 15 ? "{\"w\":\"apple\"}" : "{\"w\":\"word\(i)\"}" }
        let file = try await JsonFile.open(path: try dir.file("search-early.json", "[" + items.joined(separator: ",") + "]"))
        let result = try #require(try await file.search("apple"))
        #expect(result.hits.count == 10)
        #expect(result.hits.allSatisfy { $0.tier == 1 })
        #expect(result.moreAvailable == true)
    }

    @Test func returnsSnippetsAndEnclosingField() async throws {
        let long = String(repeating: "lorem ipsum ", count: 20) + "apple pie recipe " + String(repeating: "dolor sit. ", count: 20)
        let file = try await JsonFile.open(path: try dir.file("search-snippet.json", "[{\"body\":\"\(long)\"}]"))
        let result = try #require(try await file.search("pie"))
        let hit = try #require(result.hits.first)
        #expect(hit.field == "body")
        #expect(hit.snippet.contains("…"))
        #expect(hit.snippet.contains("apple pie"))
        #expect(hit.snippet.count < 120)
    }

    @Test func handlesMultibyteContent() async throws {
        let emoji = "\u{1F34E}"
        let file = try await JsonFile.open(path: try dir.file("search-utf8.json", "[{\"note\":\"\(emoji) is a red apple \(emoji)\"},{\"n\":1}]"))
        let result = try #require(try await file.search(emoji))
        #expect(result.hits.count == 1)
        #expect(result.hits[0].index == 0)
        #expect(result.hits[0].snippet.contains(emoji))
        #expect(!result.hits[0].snippet.contains("\u{FFFD}"))
        #expect(result.hits[0].snippetParts.match == emoji)
    }

    @Test func reportsMatchOffsetsInsideSnippet() async throws {
        let file = try await JsonFile.open(path: try dir.file("search-offset.json", #"[{"body":"a tiny apple sits here"}]"#))
        let result = try await file.search("Apple")
        #expect(result == SearchResult(hits: [
            SearchHitBase(index: 0, tier: 3, field: "body", snippet: #"{"body":"a tiny apple sits here"}"#, matchStart: 16, matchLength: 5)
        ], moreAvailable: false))
    }

    @Test func narrowsWhenQueryExtendsPrevious() async throws {
        let file = try await JsonFile.open(path: try dir.file("search-narrow.json", #"[{"w":"app"},{"w":"apple"},{"w":"application"}]"#))
        let first = try await file.search("app")
        #expect(hitIndexes(first) == [0, 1, 2])
        #expect(hitTiers(first) == [1, 2, 2])
        let second = try await file.search("appl")
        #expect(hitIndexes(second) == [1, 2])
        let third = try await file.search("apple")
        #expect(hitIndexes(third) == [1])
        #expect(hitTiers(third) == [1])
    }

    @Test func classifiesPrettyPrintedJson() async throws {
        let file = try await JsonFile.open(path: try dir.file("search-pretty.json", "[\n  {\n    \"word\": \"fig\"\n  },\n  {\n    \"word\": \"apple\"\n  }\n]"))
        let result = try #require(try await file.search("apple"))
        #expect(result.hits.count == 1)
        #expect(result.hits[0].index == 1)
        #expect(result.hits[0].tier == 1)
        #expect(result.hits[0].field == "word")
    }

    @Test func keepsMoreAvailableTruthfulOnMemoPath() async throws {
        let exact = (0..<10).map { "{\"w\":\"apples \($0)\"}" }
        let file = try await JsonFile.open(path: try dir.file("search-memo-exact.json", "[" + exact.joined(separator: ",") + "]"))
        let first = try #require(try await file.search("apple"))
        #expect(first.moreAvailable == false)
        let second = try #require(try await file.search("apples"))
        #expect(second.hits.count == 10)
        #expect(second.moreAvailable == false)

        let many = (0..<12).map { "{\"w\":\"apples \($0)\"}" }
        let file2 = try await JsonFile.open(path: try dir.file("search-memo-more.json", "[" + many.joined(separator: ",") + "]"))
        let third = try #require(try await file2.search("apples"))
        #expect(third.moreAvailable == true)
        let fourth = try #require(try await file2.search("apples 1"))
        #expect(fourth.hits.map(\.index) == [1, 10, 11])
        #expect(fourth.moreAvailable == false)
    }

    @Test func ranksMemoPathLikeFullScan() async throws {
        var items = [#"{"a":"crabapple sauce","b":"apple sauce"}"#]
        items += (0..<10).map { "{\"w\":\"apple s \($0)\"}" }
        let path = try dir.file("search-memo-rank.json", "[" + items.joined(separator: ",") + "]")
        let file = try await JsonFile.open(path: path)
        _ = try await file.search("apple")
        let narrowed = try #require(try await file.search("apple s"))
        let fresh = try await JsonFile.open(path: path)
        let scanned = try #require(try await fresh.search("apple s"))
        #expect(narrowed == scanned)
        #expect(narrowed.hits[0].index == 0)
        #expect(narrowed.hits[0].tier == 2)
        for hit in narrowed.hits {
            #expect(hit.snippetParts.match.lowercased() == "apple s")
        }
    }

    @Test func revealsBetterMatchesWhenIncompleteMemoNarrows() async throws {
        var items = (0..<10).map { "{\"w\":\"apricot pie \($0)\"}" }
        items += [#"{"w":"apricot"}"#, #"{"w":"apricot"}"#]
        let file = try await JsonFile.open(path: try dir.file("search-memo-incomplete.json", "[" + items.joined(separator: ",") + "]"))
        let first = try #require(try await file.search("ap"))
        #expect(first.hits.map(\.index) == Array(0..<10))
        #expect(first.moreAvailable == true)
        let second = try #require(try await file.search("apricot"))
        #expect(second.hits[0].index == 10)
        #expect(second.hits[0].tier == 1)
        #expect(second.hits[1].index == 11)
        #expect(second.hits[1].tier == 1)
        #expect(second.hits.count == 10)
    }

    @Test func ordersMemoNarrowedHitsByTier() async throws {
        var items = (0..<9).map { "{\"w\":\"apple pie \($0)\"}" }
        items.append(#"{"w":"apple"}"#)
        let file = try await JsonFile.open(path: try dir.file("search-memo-order.json", "[" + items.joined(separator: ",") + "]"))
        _ = try await file.search("app")
        let narrowed = try #require(try await file.search("apple"))
        #expect(narrowed.hits.map(\.index) == [9, 0, 1, 2, 3, 4, 5, 6, 7, 8])
        #expect(narrowed.hits[0].tier == 1)
        #expect(narrowed.moreAvailable == false)
    }

    @Test func neverClassifiesKeysAsValueMatches() async throws {
        let file = try await JsonFile.open(path: try dir.file("search-keys.json", #"[{"apple":1},{"w":"apple"},{"apple pie":2}]"#))
        let result = try await file.search("apple")
        #expect(hitIndexes(result) == [1, 0, 2])
        #expect(hitTiers(result) == [1, 3, 3])
    }

    @Test func treatsNestedArrayStringsAsValues() async throws {
        let file = try await JsonFile.open(path: try dir.file("search-nested-value.json", #"[["apple","banana"]]"#))
        let result = try #require(try await file.search("banana"))
        #expect(result.hits[0].tier == 1)
    }

    @Test func cancelsThroughCallback() async throws {
        let items = (0..<100).map { "{\"text\":\"item with apple \($0)\"}" }
        let file = try await JsonFile.open(path: try dir.file("search-cancel.json", "[" + items.joined(separator: ",") + "]"))
        let result = try await file.search("apple", isCanceled: { true })
        #expect(result == nil)
    }

    @Test func returnsNoHitsForEmptyQuery() async throws {
        let file = try await JsonFile.open(path: try dir.file("search-empty.json", #"[{"a":1}]"#))
        #expect(try await file.search("") == SearchResult(hits: [], moreAvailable: false))
    }

    @Test func worksOnArraysOfPlainStrings() async throws {
        let file = try await JsonFile.open(path: try dir.file("search-strings.json", #"["banana", "apple", "pineapple"]"#))
        let result = try await file.search("apple")
        #expect(hitIndexes(result) == [1, 2])
        #expect(hitTiers(result) == [1, 3])
    }

    @Test func rejectsSearchingNonArrayRoots() async throws {
        let file = try await JsonFile.open(path: try dir.file("search-object.json", #"{"word": "apple"}"#))
        #expect(await file.searchable == false)
        await #expect(throws: JsonError.self) { try await file.search("apple") }
    }
}

@Suite("JsonFile non-array roots")
struct ValueRootTests {
    let dir = try! FixtureDirectory("json-reader-value")

    @Test func loadsObjectRootInOrder() async throws {
        let file = try await JsonFile.open(path: try dir.file("object.json", "{\n  \"name\": \"John\",\n  \"age\": 30\n}"))
        #expect(await file.root == .value(["name": "John", "age": 30]))
    }

    @Test func loadsStringRoot() async throws {
        let file = try await JsonFile.open(path: try dir.file("string.json", "\"hello\""))
        #expect(await file.root == .value("hello"))
    }

    @Test func loadsNumberRoot() async throws {
        let file = try await JsonFile.open(path: try dir.file("number.json", "123"))
        #expect(await file.root == .value(123))
    }

    @Test func loadsNullAndBooleanRoots() async throws {
        let n = try await JsonFile.open(path: try dir.file("null.json", "null"))
        #expect(await n.root == .value(nil))
        let t = try await JsonFile.open(path: try dir.file("true.json", "true"))
        #expect(await t.root == .value(true))
    }

    @Test func loadsNestedObjectRoot() async throws {
        let file = try await JsonFile.open(path: try dir.file("nested-object.json", #"{"word": "apple", "examples": ["I ate an apple.", "The apple is red."]}"#))
        #expect(await file.root == .value(["word": "apple", "examples": ["I ate an apple.", "The apple is red."]]))
    }
}

@Suite("JsonFile invalid input")
struct InvalidInputTests {
    let dir = try! FixtureDirectory("json-reader-invalid")

    private func openError(_ path: String, chunkSize: Int = JsonFile.defaultChunkSize) async -> JsonError? {
        do {
            _ = try await JsonFile.open(path: path, chunkSize: chunkSize)
            return nil
        } catch let error as JsonError {
            return error
        } catch {
            return nil
        }
    }

    @Test func reportsLineOfInvalidPrimitive() async throws {
        let error = await openError(try dir.file("bad-primitive.json", "[\n  1,\n  2,\n  oops\n]"))
        #expect(error?.message.contains("line 4") == true)
    }

    @Test func rejectsUnterminatedString() async throws {
        #expect(await openError(try dir.file("unterminated.json", "[\"abc")) != nil)
    }

    @Test func rejectsTruncatedArray() async throws {
        let error = await openError(try dir.file("truncated.json", "[1, 2"))
        #expect(error?.message.lowercased().contains("unexpected end") == true)
    }

    @Test func rejectsTruncatedObjectRoot() async throws {
        let error = await openError(try dir.file("truncated-object.json", "{\"a\": 1"))
        #expect(error?.message.lowercased().contains("unexpected end") == true)
    }

    @Test func rejectsCharactersAfterRoot() async throws {
        let error = await openError(try dir.file("trailing.json", "{\"a\": 1} x"))
        #expect(error?.message.lowercased().contains("after") == true)
    }

    @Test func rejectsCharactersAfterArrayRootInSameOrNextChunk() async throws {
        #expect(await openError(try dir.file("trailing-array.json", "[1, 2] x"))?.message.lowercased().contains("after") == true)
        #expect(await openError(try dir.file("trailing-empty-array.json", "[] garbage"))?.message.lowercased().contains("after") == true)
        #expect(await openError(try dir.file("trailing-array-next-chunk.json", "[1, 2] x"), chunkSize: 6)?.message.lowercased().contains("after") == true)
    }

    @Test func rejectsEmptySlotBetweenCommas() async throws {
        #expect(await openError(try dir.file("empty-slot.json", "[1,,2]")) != nil)
    }

    @Test func rejectsTrailingComma() async throws {
        #expect(await openError(try dir.file("trailing-comma.json", "[1, 2,]")) != nil)
    }

    @Test func rejectsMismatchedBrackets() async throws {
        let ok = try await JsonFile.open(path: try dir.file("mismatch.json", "[{\"a\": 1}]"))
        #expect(await ok.root == .array(count: 1))
        #expect(await openError(try dir.file("mismatch2.json", "[{\"a\": 1]")) != nil)
    }

    @Test func rejectsInvalidObjectRootWithLine() async throws {
        let error = await openError(try dir.file("bad-object.json", "{\n  \"a\": 1,\n  \"b\": oops\n}"))
        #expect(error?.message.contains("line 3") == true)
    }

    @Test func rejectsEmptyFile() async throws {
        #expect(await openError(try dir.file("empty.json", ""))?.message.lowercased().contains("empty") == true)
    }

    @Test func rejectsWhitespaceOnlyFile() async throws {
        #expect(await openError(try dir.file("blank.json", "  \n \n "))?.message.lowercased().contains("empty") == true)
    }

    @Test func rejectsMissingFileReadably() async throws {
        let error = await openError(dir.url.appendingPathComponent("does-not-exist.json").path)
        #expect(error?.message == "The file could not be found.")
    }

    @Test func rejectsFolderPath() async throws {
        let error = await openError(dir.path)
        #expect(error?.message == "That path is a folder, not a file.")
    }
}
