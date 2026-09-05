import Foundation

/// What committing a typed item number should do.
enum ItemJump: Equatable {
    case jump(index: Int)
    case invalid
    case noop
}

/// Groups larger than this many items/entries start collapsed.
let largeGroupThreshold = 20

enum ReadingRules {
    /// The largest integer the previous implementation accepted as a jump target.
    static let maxSafeInteger = 9_007_199_254_740_991

    /// Decides what committing a typed item number should do.
    ///
    /// - A number in `1...count` (surrounding whitespace and thousands
    ///   separators tolerated) jumps to that item, as a 0-based index.
    /// - Empty input is a no-op: clearing the field and pressing Enter just
    ///   restores the current number.
    /// - Anything else — text, decimals, signs, zero, out of range, or digits
    ///   too large for a safe integer — is invalid and must never jump.
    static func parseItemJump(_ raw: String, count: Int) -> ItemJump {
        let digits = raw.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: ",", with: "")
        if digits.isEmpty { return .noop }
        guard digits.utf8.allSatisfy({ $0 >= UInt8(ascii: "0") && $0 <= UInt8(ascii: "9") }) else { return .invalid }
        guard let n = Int(digits), n <= maxSafeInteger, n >= 1, n <= count else { return .invalid }
        return .jump(index: n - 1)
    }

    /// Decides whether a group starts collapsed when an item first opens:
    /// only unusually large groups hide their content behind a click; small
    /// ones stay readable without interaction.
    static func shouldCollapse(count: Int) -> Bool {
        count > largeGroupThreshold
    }
}

struct FileSwitchFolder: Equatable {
    var fileCount: Int
    var activeIndex: Int
}

enum FileSwitchDecision: Equatable {
    case open(index: Int)
    case none
}

enum SwitchDirection {
    case previous, next
}

enum FileSwitching {
    /// Decides what an Up/Down arrow press should do.
    ///
    /// File switching only exists while a folder with more than one file is
    /// open; with zero or one file there is nothing to switch to, so the keys
    /// do nothing. The index never wraps past the first or last file.
    static func decide(_ direction: SwitchDirection, folder: FileSwitchFolder?) -> FileSwitchDecision {
        guard let folder, folder.fileCount >= 2 else { return .none }
        let index = direction == .previous ? folder.activeIndex - 1 : folder.activeIndex + 1
        if index < 0 || index >= folder.fileCount { return .none }
        return .open(index: index)
    }

    /// The freshest requested file position: a queued panel/keyboard request
    /// outranks the in-flight load, which outranks the last finished file.
    /// Reading only the in-flight load makes rapid presses recompute the same
    /// step and collapse into one. `-1` means nothing was ever requested.
    static func latestRequestedIndex(pending: Int?, loading: Int?, settled: Int?) -> Int {
        pending ?? loading ?? settled ?? -1
    }
}

struct SelectFolder: Equatable {
    var fileCount: Int
    var activeIndex: Int
}

enum SearchSelectDecision: Equatable {
    case open(index: Int, itemIndex: Int)
    case jump(itemIndex: Int)
    case none
}

enum SearchSelection {
    /// Decides what selecting a search hit should do.
    ///
    /// - A hit in a file other than the active one opens that file and jumps
    ///   to the hit's item.
    /// - A hit in the active file jumps straight to the item — unless that
    ///   file is still loading, where the open machinery's last-write-wins
    ///   queue must take the request instead (the plain jump is a no-op on
    ///   the loading view, so the hit would otherwise be dropped).
    /// - Without a folder, a hit only matters when the current view is an array.
    static func decide(hit: SearchHit, folder: SelectFolder?, loading: Bool, viewIsArray: Bool) -> SearchSelectDecision {
        if let folder, hit.fileIndex >= 0, hit.fileIndex < folder.fileCount {
            let sameFile = hit.fileIndex == folder.activeIndex
            if !sameFile || loading { return .open(index: hit.fileIndex, itemIndex: hit.index) }
        }
        if viewIsArray { return .jump(itemIndex: hit.index) }
        return .none
    }
}
