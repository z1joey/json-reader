import Foundation
import Testing
@testable import JSONReader

@Suite("parseItemJump")
struct ItemJumpTests {
    @Test func jumpsToZeroBasedIndex() {
        #expect(ReadingRules.parseItemJump("1", count: 120_000) == .jump(index: 0))
        #expect(ReadingRules.parseItemJump("5000", count: 120_000) == .jump(index: 4999))
        #expect(ReadingRules.parseItemJump("120000", count: 120_000) == .jump(index: 119_999))
    }

    @Test func ignoresWhitespaceAndThousandsSeparators() {
        #expect(ReadingRules.parseItemJump(" 12 ", count: 100) == .jump(index: 11))
        #expect(ReadingRules.parseItemJump("3,456", count: 10_000) == .jump(index: 3455))
        #expect(ReadingRules.parseItemJump("1,000,000", count: 1_000_000) == .jump(index: 999_999))
    }

    @Test func treatsEmptyInputAsNoop() {
        #expect(ReadingRules.parseItemJump("", count: 100) == .noop)
        #expect(ReadingRules.parseItemJump("   ", count: 100) == .noop)
        #expect(ReadingRules.parseItemJump(",", count: 100) == .noop)
    }

    @Test func rejectsNonNumericDecimalsAndSigns() {
        for raw in ["abc", "12a", "3.5", "-5", "+5", "1e3"] {
            #expect(ReadingRules.parseItemJump(raw, count: 100) == .invalid, "\(raw)")
        }
    }

    @Test func rejectsZeroAndOutOfRange() {
        #expect(ReadingRules.parseItemJump("0", count: 100) == .invalid)
        #expect(ReadingRules.parseItemJump("101", count: 100) == .invalid)
        #expect(ReadingRules.parseItemJump("18446744073709551617", count: 100) == .invalid)
        #expect(ReadingRules.parseItemJump("9007199254740993", count: Int.max) == .invalid)
    }

    @Test func rejectsAnythingWhenArrayIsEmpty() {
        #expect(ReadingRules.parseItemJump("1", count: 0) == .invalid)
    }
}

@Suite("shouldCollapse")
struct FoldPolicyTests {
    @Test func leavesGroupsUpToThresholdExpanded() {
        #expect(ReadingRules.shouldCollapse(count: 0) == false)
        #expect(ReadingRules.shouldCollapse(count: 1) == false)
        #expect(ReadingRules.shouldCollapse(count: largeGroupThreshold) == false)
    }

    @Test func collapsesLargerGroups() {
        #expect(ReadingRules.shouldCollapse(count: largeGroupThreshold + 1) == true)
        #expect(ReadingRules.shouldCollapse(count: 5000) == true)
    }
}

@Suite("decideFileSwitch")
struct FileSwitchTests {
    let threeFiles = FileSwitchFolder(fileCount: 3, activeIndex: 1)

    @Test func opensNextAndPreviousFile() {
        #expect(FileSwitching.decide(.next, folder: threeFiles) == .open(index: 2))
        #expect(FileSwitching.decide(.previous, folder: threeFiles) == .open(index: 0))
    }

    @Test func stopsAtEndsInsteadOfWrapping() {
        #expect(FileSwitching.decide(.previous, folder: FileSwitchFolder(fileCount: 3, activeIndex: 0)) == .none)
        #expect(FileSwitching.decide(.next, folder: FileSwitchFolder(fileCount: 3, activeIndex: 2)) == .none)
    }

    @Test func doesNothingWithFewerThanTwoFiles() {
        #expect(FileSwitching.decide(.next, folder: FileSwitchFolder(fileCount: 1, activeIndex: 0)) == .none)
        #expect(FileSwitching.decide(.previous, folder: FileSwitchFolder(fileCount: 1, activeIndex: 0)) == .none)
        #expect(FileSwitching.decide(.next, folder: FileSwitchFolder(fileCount: 0, activeIndex: 0)) == .none)
    }

    @Test func doesNothingWithoutFolder() {
        #expect(FileSwitching.decide(.next, folder: nil) == .none)
        #expect(FileSwitching.decide(.previous, folder: nil) == .none)
    }

    @Test func prefersQueuedOverLoadingOverSettled() {
        #expect(FileSwitching.latestRequestedIndex(pending: 2, loading: 0, settled: 0) == 2)
        #expect(FileSwitching.latestRequestedIndex(pending: nil, loading: 1, settled: 0) == 1)
        #expect(FileSwitching.latestRequestedIndex(pending: nil, loading: nil, settled: 4) == 4)
        #expect(FileSwitching.latestRequestedIndex(pending: nil, loading: nil, settled: nil) == -1)
    }

    @Test func advancesOneFilePerPressWhileLoading() {
        var pending: Int?
        func press() -> Int {
            let activeIndex = FileSwitching.latestRequestedIndex(pending: pending, loading: 0, settled: 0)
            if case .open(let index) = FileSwitching.decide(.next, folder: FileSwitchFolder(fileCount: 5, activeIndex: activeIndex)) {
                pending = index
            }
            return activeIndex
        }
        #expect(press() == 0)
        #expect(press() == 1)
        #expect(press() == 2)
        #expect(pending == 3)
    }
}

@Suite("decideSearchSelect")
struct SearchSelectTests {
    private func hit(_ fileIndex: Int, _ index: Int) -> SearchHit {
        SearchHit(
            base: SearchHitBase(index: index, tier: 1, field: nil, snippet: "apple", matchStart: 0, matchLength: 5),
            fileIndex: fileIndex,
            fileName: "a.json"
        )
    }

    let folder = SelectFolder(fileCount: 2, activeIndex: 0)

    @Test func opensAnotherFileAndJumps() {
        #expect(SearchSelection.decide(hit: hit(1, 3), folder: folder, loading: false, viewIsArray: true) == .open(index: 1, itemIndex: 3))
    }

    @Test func jumpsInsideActiveArrayFile() {
        #expect(SearchSelection.decide(hit: hit(0, 4), folder: folder, loading: false, viewIsArray: true) == .jump(itemIndex: 4))
    }

    @Test func queuesHitForLoadingFile() {
        #expect(SearchSelection.decide(hit: hit(0, 2), folder: folder, loading: true, viewIsArray: false) == .open(index: 0, itemIndex: 2))
    }

    @Test func ignoresHitsOutsideFolder() {
        #expect(SearchSelection.decide(hit: hit(5, 0), folder: folder, loading: false, viewIsArray: false) == .none)
    }

    @Test func dropsHitWithoutFolderUnlessArray() {
        #expect(SearchSelection.decide(hit: hit(0, 1), folder: nil, loading: false, viewIsArray: false) == .none)
        #expect(SearchSelection.decide(hit: hit(0, 1), folder: nil, loading: false, viewIsArray: true) == .jump(itemIndex: 1))
    }
}

@Suite("JsonValueParser")
struct JsonValueParserTests {
    @Test func preservesObjectKeyOrder() throws {
        let value = try JsonValueParser.parse(#"{"z": 1, "a": 2, "m": [true, null]}"#)
        guard case .object(let members) = value else { Issue.record("not an object"); return }
        #expect(members.map(\.key) == ["z", "a", "m"])
        #expect(members[2].value == [true, nil])
    }

    @Test func decodesEscapesIncludingSurrogatePairs() throws {
        let value = try JsonValueParser.parse(#""tab\there \u00e9 \ud83c\udf4e \"q\" \\ \/""#)
        #expect(value == "tab\there é \u{1F34E} \"q\" \\ /")
    }

    @Test func parsesNumbersLikeJavaScript() throws {
        #expect(try JsonValueParser.parse("-2.5e3") == -2500)
        #expect(JsonValue.number(-2500).displayString() == "-2500")
        #expect(JsonValue.number(1.5).displayString() == "1.5")
        #expect(JsonValue.number(1e21).displayString() == "1e+21")
    }

    @Test func rejectsMalformedInputWithLine() {
        for text in ["{\"a\":}", "[1,]", "01", "\"unterminated", "{\"a\" 1}", "tru", "[1] x", "\"raw\ncontrol\""] {
            #expect(throws: JsonError.self, "\(text)") { try JsonValueParser.parse(text) }
        }
        do {
            _ = try JsonValueParser.parse("{\n  \"a\": 1,\n  \"b\": oops\n}")
            Issue.record("expected failure")
        } catch let error as JsonError {
            #expect(error.message == "Invalid JSON at line 3.")
        } catch {
            Issue.record("unexpected error \(error)")
        }
    }
}

@Suite("JsonPointer")
struct JsonPointerTests {
    let doc: JsonValue = [
        "foo": ["bar", "baz"],
        "": 0,
        "a/b": 1,
        "c%d": 2,
        "e^f": 3,
        "g|h": 4,
        "i\\j": 5,
        "k\"l": 6,
        " ": 7,
        "m~n": 8,
        "dupe": 1,
        "dupe": 2
    ]

    @Test func escapesAndUnescapesTokens() {
        #expect(JsonPointer.escapeToken("a/b") == "a~1b")
        #expect(JsonPointer.escapeToken("m~n") == "m~0n")
        #expect(JsonPointer.unescapeToken("~01") == "~1")
        #expect(JsonPointer.appending("", token: "a/b") == "/a~1b")
        #expect(JsonPointer.appending("/x", token: "3") == "/x/3")
    }

    @Test func resolvesRfc6901Examples() {
        #expect(JsonPointer.resolve(doc, pointer: "") == doc)
        #expect(JsonPointer.resolve(doc, pointer: "/foo") == ["bar", "baz"])
        #expect(JsonPointer.resolve(doc, pointer: "/foo/0") == "bar")
        #expect(JsonPointer.resolve(doc, pointer: "/") == 0)
        #expect(JsonPointer.resolve(doc, pointer: "/a~1b") == 1)
        #expect(JsonPointer.resolve(doc, pointer: "/c%d") == 2)
        #expect(JsonPointer.resolve(doc, pointer: "/e^f") == 3)
        #expect(JsonPointer.resolve(doc, pointer: "/g|h") == 4)
        #expect(JsonPointer.resolve(doc, pointer: "/i\\j") == 5)
        #expect(JsonPointer.resolve(doc, pointer: "/k\"l") == 6)
        #expect(JsonPointer.resolve(doc, pointer: "/ ") == 7)
        #expect(JsonPointer.resolve(doc, pointer: "/m~0n") == 8)
    }

    @Test func lastDuplicateKeyWins() {
        #expect(JsonPointer.resolve(doc, pointer: "/dupe") == 2)
    }

    @Test func returnsNilForMissingOrNonCanonicalPaths() {
        #expect(JsonPointer.resolve(doc, pointer: "/nope") == nil)
        #expect(JsonPointer.resolve(doc, pointer: "/foo/2") == nil)
        #expect(JsonPointer.resolve(doc, pointer: "/foo/01") == nil)
        #expect(JsonPointer.resolve(doc, pointer: "/foo/-1") == nil)
        #expect(JsonPointer.resolve(doc, pointer: "/foo/0/x") == nil)
        #expect(JsonPointer.resolve(doc, pointer: "foo") == nil)
    }
}
