import SwiftUI

/// Attaches comment affordances to a tree node: a badge when the node has a
/// comment, a context menu to add/edit/remove one.
struct CommentableModifier: ViewModifier {
    @Environment(CommentStore.self) private var store
    let pointer: String
    @State private var showsPopover = false

    func body(content: Content) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            content
            if let comment = store.comment(at: pointer) {
                Button {
                    showsPopover = true
                } label: {
                    Image(systemName: "text.bubble.fill")
                        .font(.caption2)
                        .foregroundStyle(Color.accentColor)
                }
                .buttonStyle(.plain)
                .help(comment.text)
                .popover(isPresented: $showsPopover, arrowEdge: .bottom) {
                    CommentBadgePopover(comment: comment)
                        .environment(store)
                }
            }
        }
        .contextMenu {
            if store.comment(at: pointer) != nil {
                Button("Edit Comment…") { store.beginEditing(pointer) }
                Button("Remove Comment", role: .destructive) { store.remove(pointer: pointer) }
            } else {
                Button("Add Comment…") { store.beginEditing(pointer) }
            }
        }
    }
}

extension View {
    /// Marks this node as a comment target identified by its JSON Pointer.
    func commentable(_ pointer: String) -> some View {
        modifier(CommentableModifier(pointer: pointer))
    }
}

/// What clicking a comment badge shows: the note, where it points, and the
/// same edit/remove actions as the context menu.
struct CommentBadgePopover: View {
    @Environment(CommentStore.self) private var store
    let comment: EntityComment

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(comment.text)
                .textSelection(.enabled)
                .frame(maxWidth: 320, alignment: .leading)
            Text(humanizedPointer(comment.pointer))
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
            HStack {
                Button("Edit…") { store.beginEditing(comment.pointer) }
                Button("Remove", role: .destructive) { store.remove(pointer: comment.pointer) }
            }
        }
        .padding(12)
    }
}

/// The add/edit sheet. Saving writes through the store immediately; Delete
/// removes the comment for good.
struct CommentEditorSheet: View {
    @Environment(CommentStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let editing: CommentEditing

    @State private var text: String

    init(editing: CommentEditing) {
        self.editing = editing
        _text = State(initialValue: editing.existing?.text ?? "")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(editing.existing == nil ? "Add Comment" : "Edit Comment")
                .font(.headline)
            Text(humanizedPointer(editing.pointer))
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
            TextEditor(text: $text)
                .font(.body)
                .frame(minWidth: 420, idealWidth: 480, minHeight: 120, idealHeight: 150)
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(.quaternary))
            HStack {
                if editing.existing != nil {
                    Button("Delete", role: .destructive) {
                        store.remove(pointer: editing.pointer)
                        dismiss()
                    }
                }
                Spacer()
                Button("Cancel") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button(editing.existing == nil ? "Add" : "Save") {
                    store.upsert(pointer: editing.pointer, text: trimmedText)
                    dismiss()
                }
                .keyboardShortcut(.defaultAction)
                .disabled(trimmedText.isEmpty)
            }
        }
        .padding(16)
    }

    private var trimmedText: String {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

/// A readable rendering of a document pointer ("/3/tags/1" reads as
/// "item 4 · tags · 1", matching the 1-based item numbers shown in the UI).
func humanizedPointer(_ pointer: String) -> String {
    guard pointer.hasPrefix("/") else { return pointer.isEmpty ? "the whole document" : pointer }
    let tokens = pointer.dropFirst().split(separator: "/", omittingEmptySubsequences: false).map(String.init)
    var parts: [String] = []
    for (index, token) in tokens.enumerated() {
        if index == 0, let item = Int(token) {
            parts.append("item \(item + 1)")
        } else if let indexNumber = Int(token) {
            parts.append("[\(indexNumber)]")
        } else {
            parts.append(token)
        }
    }
    return parts.joined(separator: " › ")
}
