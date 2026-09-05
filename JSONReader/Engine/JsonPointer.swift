import Foundation

/// RFC 6901 JSON Pointer: the stable textual address of a node inside a JSON
/// document ("" is the root, "/3/tags/1" drills into item 3's tags array).
/// Comments attach to nodes through these pointers.
enum JsonPointer {
    /// Escapes one reference token: `~` becomes `~0`, `/` becomes `~1`.
    static func escapeToken(_ token: String) -> String {
        token
            .replacingOccurrences(of: "~", with: "~0")
            .replacingOccurrences(of: "/", with: "~1")
    }

    /// Reverses `escapeToken`. `~1` is decoded before `~0` so that `~01`
    /// yields `~1` and not `/`, as the RFC requires.
    static func unescapeToken(_ token: String) -> String {
        token
            .replacingOccurrences(of: "~1", with: "/")
            .replacingOccurrences(of: "~0", with: "~")
    }

    /// Appends one escaped token to a pointer.
    static func appending(_ pointer: String, token: String) -> String {
        pointer + "/" + escapeToken(token)
    }

    /// Resolves `pointer` against `root`, returning nil when any step is
    /// missing. Duplicate object keys resolve to the last occurrence, matching
    /// how a JSON parser would have replaced the earlier one.
    static func resolve(_ root: JsonValue, pointer: String) -> JsonValue? {
        if pointer.isEmpty { return root }
        guard pointer.hasPrefix("/") else { return nil }
        var current = root
        for rawToken in pointer.dropFirst().split(separator: "/", omittingEmptySubsequences: false) {
            guard let next = step(from: current, rawToken: String(rawToken)) else { return nil }
            current = next
        }
        return current
    }

    private static func step(from value: JsonValue, rawToken: String) -> JsonValue? {
        let token = unescapeToken(rawToken)
        switch value {
        case .object(let entries):
            return entries.last(where: { $0.key == token })?.value
        case .array(let items):
            // Only canonical indexes ("3", never "03" or "+3") address elements.
            guard let index = Int(token), index >= 0, index < items.count, token == String(index) else {
                return nil
            }
            return items[index]
        case .null, .bool, .number, .string:
            return nil
        }
    }
}
