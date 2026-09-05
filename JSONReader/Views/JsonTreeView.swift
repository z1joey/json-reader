import SwiftUI

/// Strings longer than this are truncated until the reader asks for the rest.
let longStringThreshold = 5000

/// Human-readable rendering of any JSON value: objects read as label/value
/// entries, arrays as numbered lists, nested groups fold behind a count
/// summary and carry a thin depth-colored rule instead of deep indentation.
struct JsonTreeView: View {
    let value: JsonValue

    var body: some View {
        ScrollView {
            JsonNodeView(value: value, pointer: "", depth: 0)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(20)
                .textSelection(.enabled)
        }
    }
}

struct JsonNodeView: View {
    let value: JsonValue
    /// JSON Pointer of this node from the item root, e.g. "/tags/1".
    let pointer: String
    let depth: Int

    var body: some View {
        switch value {
        case .null:
            Text("null")
                .foregroundStyle(.secondary)
                .italic()
        case .bool(let flag):
            Text(flag ? "true" : "false")
                .foregroundStyle(.orange)
        case .number(let number):
            Text(JsonValue.formatNumber(number))
                .foregroundStyle(.blue)
                .monospacedDigit()
        case .string(let text):
            LongStringView(text: text)
        case .array(let items):
            if items.isEmpty {
                EmptyLabel(text: "Empty array")
            } else {
                GroupView(kind: .array, count: items.count, depth: depth) {
                    LazyVStack(alignment: .leading, spacing: 6) {
                        ForEach(items.indices, id: \.self) { index in
                            HStack(alignment: .firstTextBaseline, spacing: 8) {
                                Text("\(index)")
                                    .foregroundStyle(.tertiary)
                                    .monospacedDigit()
                                    .frame(minWidth: 18, alignment: .trailing)
                                JsonNodeView(
                                    value: items[index],
                                    pointer: JsonPointer.appending(pointer, token: String(index)),
                                    depth: depth + 1
                                )
                            }
                        }
                    }
                }
            }
        case .object(let members):
            if members.isEmpty {
                EmptyLabel(text: "Empty object")
            } else {
                GroupView(kind: .object, count: members.count, depth: depth) {
                    LazyVStack(alignment: .leading, spacing: 6) {
                        ForEach(members.indices, id: \.self) { index in
                            FieldRow(key: members[index].key, isContainer: members[index].value.isNonEmptyContainer) {
                                JsonNodeView(
                                    value: members[index].value,
                                    pointer: JsonPointer.appending(pointer, token: members[index].key),
                                    depth: depth + 1
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

extension JsonValue {
    var isNonEmptyContainer: Bool {
        switch self {
        case .array(let items): return !items.isEmpty
        case .object(let members): return !members.isEmpty
        default: return false
        }
    }
}

/// One `key: value` entry. Scalars sit beside their key; nested groups start
/// on the next line so their fold control lines up under the key.
struct FieldRow<Content: View>: View {
    let key: String
    let isContainer: Bool
    @ViewBuilder let content: () -> Content

    var body: some View {
        if isContainer {
            VStack(alignment: .leading, spacing: 3) {
                keyLabel
                content()
            }
        } else {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                keyLabel
                content()
            }
        }
    }

    private var keyLabel: some View {
        Text(key.isEmpty ? "\"\"" : key)
            .fontWeight(.medium)
            .foregroundStyle(.secondary)
    }
}

/// A foldable object or array: a header button showing the count, then the
/// body only while expanded. Unusually large groups start collapsed so an
/// item opens as a readable overview instead of a wall.
struct GroupView<Content: View>: View {
    enum Kind { case array, object }

    let kind: Kind
    let count: Int
    let depth: Int
    @ViewBuilder let content: () -> Content
    @State private var isOpen: Bool

    init(kind: Kind, count: Int, depth: Int, @ViewBuilder content: @escaping () -> Content) {
        self.kind = kind
        self.count = count
        self.depth = depth
        self.content = content
        _isOpen = State(initialValue: !ReadingRules.shouldCollapse(count: count))
    }

    private var summary: String {
        let noun: String
        switch kind {
        case .array: noun = count == 1 ? "item" : "items"
        case .object: noun = count == 1 ? "entry" : "entries"
        }
        return "\(count.formatted()) \(noun)"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button {
                isOpen.toggle()
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "chevron.right")
                        .font(.caption2.bold())
                        .rotationEffect(.degrees(isOpen ? 90 : 0))
                    Text(summary)
                        .font(.caption)
                }
                .foregroundStyle(.secondary)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(summary)
            .accessibilityAddTraits(isOpen ? [.isButton, .isSelected] : [.isButton])

            if isOpen {
                content()
                    .padding(.leading, 12)
                    .overlay(alignment: .leading) {
                        Rectangle()
                            .fill(GroupView.depthColor(depth))
                            .frame(width: 2)
                            .padding(.vertical, 2)
                    }
            }
        }
    }

    /// The hue steps with nesting depth so sibling levels stay distinguishable.
    static func depthColor(_ depth: Int) -> Color {
        Color(hue: Double((depth * 43) % 360) / 360, saturation: 0.45, brightness: 0.78)
    }
}

/// A string value; very long ones are cut until the reader asks for the rest.
struct LongStringView: View {
    let text: String
    @State private var expanded = false

    private var isLong: Bool {
        text.utf8.count > longStringThreshold && text.count > longStringThreshold
    }

    var body: some View {
        let long = isLong
        VStack(alignment: .leading, spacing: 4) {
            Text(long && !expanded ? String(text.prefix(longStringThreshold)) + "…" : text)
            if long, !expanded {
                Button("Show all \(text.count.formatted()) characters") {
                    expanded = true
                }
                .buttonStyle(.link)
                .font(.caption)
            }
        }
    }
}

struct EmptyLabel: View {
    let text: String

    var body: some View {
        Text(text)
            .foregroundStyle(.tertiary)
            .italic()
    }
}
