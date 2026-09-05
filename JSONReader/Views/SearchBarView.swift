import SwiftUI

/// The header search field with its ranked, highlighted results dropdown.
/// Results are debounced 200 ms; stale replies are dropped by sequence number.
struct SearchBarView: View {
    static let debounce: Duration = .milliseconds(200)

    @Environment(AppModel.self) private var model
    @State private var query = ""
    @State private var hits: [SearchHit] = []
    @State private var moreAvailable = false
    @State private var searching = false
    @State private var noMatches = false
    @State private var active = -1
    @State private var isOpen = false
    @State private var sequence = 0
    @State private var searchTask: Task<Void, Never>?
    @FocusState private var focused: Bool
    @State private var closeTask: Task<Void, Never>?

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(.secondary)
                .font(.callout)
            TextField("Search items…", text: $query)
                .textFieldStyle(.plain)
                .focused($focused)
                .onSubmit { pick(hits.indices.contains(active) ? hits[active] : hits.first) }
                .onExitCommand { reset() }
                .onKeyPress(.downArrow) { moveSelection(1); return .handled }
                .onKeyPress(.upArrow) { moveSelection(-1); return .handled }
            if searching {
                ProgressView()
                    .controlSize(.small)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(
            RoundedRectangle(cornerRadius: 7)
                .fill(Color(nsColor: .controlBackgroundColor))
                .shadow(color: .black.opacity(0.06), radius: 1, y: 1)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 7)
                .strokeBorder(focused ? Color.accentColor.opacity(0.7) : Color.secondary.opacity(0.3), lineWidth: 1)
        )
        .frame(maxWidth: 420)
        .overlay(alignment: .topLeading) {
            if isOpen { resultsDropdown.padding(.top, 34) }
        }
        .onChange(of: query) { scheduleSearch() }
        .onChange(of: model.searchFocusToken) { focused = true }
        .onChange(of: focused) {
            if focused {
                if !hits.isEmpty { isOpen = true }
            } else {
                // Clicking a result may briefly blur the field before the pick
                // lands, so the close waits a beat.
                closeTask?.cancel()
                closeTask = Task {
                    try? await Task.sleep(for: .milliseconds(150))
                    guard !Task.isCancelled else { return }
                    isOpen = false
                }
            }
        }
    }

    private func reset() {
        query = ""
        focused = false
    }

    private func moveSelection(_ delta: Int) {
        if !isOpen, !hits.isEmpty {
            isOpen = true
            return
        }
        guard !hits.isEmpty else { return }
        active = min(hits.count - 1, max(0, active + delta))
    }

    private func pick(_ hit: SearchHit?) {
        guard let hit else { return }
        model.handleSearchSelect(hit)
        isOpen = false
        active = -1
        focused = false
    }

    private func scheduleSearch() {
        searchTask?.cancel()
        sequence += 1
        let id = sequence
        let trimmed = query.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else {
            hits = []
            moreAvailable = false
            searching = false
            noMatches = false
            active = -1
            isOpen = false
            return
        }
        searching = true
        isOpen = true
        searchTask = Task {
            try? await Task.sleep(for: Self.debounce)
            guard !Task.isCancelled, id == sequence else { return }
            let result = await model.search(trimmed)
            guard !Task.isCancelled, id == sequence else { return }
            searching = false
            // 'canceled', 'error', and 'unsupported' keep the previous list.
            if case .ok(let newHits, let more) = result {
                hits = newHits
                moreAvailable = more
                noMatches = newHits.isEmpty
                active = newHits.isEmpty ? -1 : 0
            }
        }
    }

    @ViewBuilder
    private var resultsDropdown: some View {
        VStack(alignment: .leading, spacing: 0) {
            if noMatches {
                Text("No matches.")
                    .foregroundStyle(.secondary)
                    .padding(10)
            } else {
                ForEach(Array(hits.enumerated()), id: \.element.id) { rowIndex, hit in
                    SearchHitRow(hit: hit, isActive: rowIndex == active)
                        .contentShape(Rectangle())
                        .onTapGesture { pick(hit) }
                        .onHover { hovering in
                            if hovering { active = rowIndex }
                        }
                }
                if moreAvailable {
                    Text("More matches found — refine your search.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 8)
                }
            }
        }
        .frame(width: 480, alignment: .leading)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(.quaternary))
        .shadow(color: .black.opacity(0.18), radius: 10, y: 4)
    }
}

/// One result: file, enclosing field, highlighted snippet, item number.
struct SearchHitRow: View {
    let hit: SearchHit
    let isActive: Bool

    private var snippetText: Text {
        let parts = hit.base.snippetParts
        guard !parts.match.isEmpty else { return Text(hit.snippet) }
        return Text(parts.before) + Text(parts.match).bold().foregroundStyle(Color.accentColor) + Text(parts.after)
    }

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            Text(hit.fileName)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
                .frame(width: 96, alignment: .leading)
                .help(hit.fileName)
            VStack(alignment: .leading, spacing: 2) {
                if let field = hit.field {
                    Text(field)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                }
                snippetText
                    .font(.callout)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Text("#\((hit.index + 1).formatted())")
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(isActive ? Color.accentColor.opacity(0.12) : Color.clear)
    }
}
