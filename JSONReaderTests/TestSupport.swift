import Foundation
@testable import JSONReader

// Literal syntax so expected JSON trees read like the documents they describe.
extension JsonValue: ExpressibleByStringLiteral, ExpressibleByIntegerLiteral, ExpressibleByFloatLiteral,
    ExpressibleByBooleanLiteral, ExpressibleByArrayLiteral, ExpressibleByDictionaryLiteral, ExpressibleByNilLiteral {
    public init(stringLiteral value: String) { self = .string(value) }
    public init(integerLiteral value: Int) { self = .number(Double(value)) }
    public init(floatLiteral value: Double) { self = .number(value) }
    public init(booleanLiteral value: Bool) { self = .bool(value) }
    public init(nilLiteral: ()) { self = .null }
    public init(arrayLiteral elements: JsonValue...) { self = .array(elements) }
    public init(dictionaryLiteral elements: (String, JsonValue)...) {
        self = .object(elements.map { JsonMember(key: $0.0, value: $0.1) })
    }
}

/// A scratch directory that disappears with the suite instance.
final class FixtureDirectory {
    let url: URL

    init(_ prefix: String) throws {
        url = FileManager.default.temporaryDirectory.appendingPathComponent("\(prefix)-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    }

    deinit {
        try? FileManager.default.removeItem(at: url)
    }

    var path: String { url.path }

    @discardableResult
    func file(_ name: String, _ content: String) throws -> String {
        let path = url.appendingPathComponent(name).path
        try content.write(toFile: path, atomically: true, encoding: .utf8)
        return path
    }

    func folder(_ name: String, _ files: [String: String]) throws -> String {
        let folder = url.appendingPathComponent(name)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        for (file, content) in files {
            try content.write(toFile: folder.appendingPathComponent(file).path, atomically: true, encoding: .utf8)
        }
        return folder.path
    }
}
