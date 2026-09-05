import SwiftUI

/// The footer pager: previous/next buttons around the editable item position.
struct PagerBar: View {
    @Environment(AppModel.self) private var model
    let index: Int
    let count: Int

    var body: some View {
        HStack {
            Button("← Previous") { model.goPrevious() }
                .disabled(index == 0)
            Spacer()
            ItemPositionField(index: index, count: count) { model.jumpTo($0) }
            Spacer()
            Button("Next →") { model.goNext() }
                .disabled(index == count - 1)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(.bar)
    }
}

/// The current item number as an editable field, followed by the static
/// total. Typing a valid number and pressing Enter (or leaving the field)
/// jumps to that item; anything invalid flashes an error and reverts to the
/// current number.
struct ItemPositionField: View {
    /// 0-based index of the current item.
    let index: Int
    /// Total number of items; the input must stay within `1...count`.
    let count: Int
    /// Called with a validated 0-based index when a jump commits.
    let onJump: (Int) -> Void

    @State private var draft: String
    @State private var hasError = false
    @FocusState private var focused: Bool
    // Escape reverts and blurs; the blur must not then re-commit the reverted value.
    @State private var skipNextBlur = false

    init(index: Int, count: Int, onJump: @escaping (Int) -> Void) {
        self.index = index
        self.count = count
        self.onJump = onJump
        _draft = State(initialValue: String(index + 1))
    }

    private var fieldWidth: CGFloat {
        let digits = max(3, String(count).count, draft.count)
        return CGFloat(digits) * 9 + 20
    }

    var body: some View {
        HStack(spacing: 6) {
            TextField("", text: $draft)
                .textFieldStyle(.roundedBorder)
                .multilineTextAlignment(.center)
                .monospacedDigit()
                .frame(width: fieldWidth)
                .focused($focused)
                .onSubmit(commit)
                .onExitCommand {
                    skipNextBlur = true
                    revert()
                    focused = false
                }
                .overlay {
                    if hasError {
                        RoundedRectangle(cornerRadius: 5)
                            .stroke(Color.red, lineWidth: 1.5)
                    }
                }
                .accessibilityLabel("Go to item")
            Text("/ \(count.formatted())")
                .monospacedDigit()
                .foregroundStyle(.secondary)
        }
        // Any index change from outside (arrows, buttons, search, file switch)
        // wins over whatever is in the field.
        .onChange(of: index) {
            draft = String(index + 1)
            hasError = false
        }
        .onChange(of: draft) {
            hasError = false
        }
        .onChange(of: focused) {
            if focused { return }
            if skipNextBlur {
                skipNextBlur = false
                return
            }
            commit()
        }
    }

    private func revert() {
        draft = String(index + 1)
        hasError = false
    }

    private func commit() {
        switch ReadingRules.parseItemJump(draft, count: count) {
        case .jump(let target):
            // Blur after Enter re-commits the value that is already shown.
            if target != index { onJump(target) }
            draft = String(target + 1)
            hasError = false
        case .invalid:
            draft = String(index + 1)
            // Set after the draft change so the reset above does not clear it.
            DispatchQueue.main.async { hasError = true }
        case .noop:
            revert()
        }
    }
}
