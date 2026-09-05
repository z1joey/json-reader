import SwiftUI

struct ContentView: View {
    @Environment(AppModel.self) private var model
    @State private var columns: NavigationSplitViewVisibility = .detailOnly

    var body: some View {
        NavigationSplitView(columnVisibility: $columns) {
            SidebarView()
                .navigationSplitViewColumnWidth(min: 180, ideal: 220, max: 400)
        } detail: {
            DetailView()
        }
        .navigationTitle(model.view.fileName.map { "\($0) — JSON Reader" } ?? "JSON Reader")
        .onChange(of: model.folder == nil, initial: true) { _, hasNoFolder in
            columns = hasNoFolder ? .detailOnly : .all
        }
    }
}

/// The leading panel listing the JSON files of the opened folder.
struct SidebarView: View {
    @Environment(AppModel.self) private var model

    private var selection: Binding<Int?> {
        Binding(
            get: { model.folder?.activeIndex },
            set: { index in
                if let index { model.openFromFolder(index) }
            }
        )
    }

    var body: some View {
        if let folder = model.folder {
            List(selection: selection) {
                Section {
                    ForEach(Array(folder.files.enumerated()), id: \.offset) { index, name in
                        Label(name, systemImage: "doc.text")
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .help(name)
                            .tag(index)
                    }
                } header: {
                    Text(folder.name)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .help(folder.path)
                }
            }
            .listStyle(.sidebar)
            .accessibilityLabel("Files in the opened folder")
        } else {
            Text("No folder open")
                .foregroundStyle(.secondary)
        }
    }
}

struct DetailView: View {
    @Environment(AppModel.self) private var model

    /// Search state resets when the search scope (folder or file) changes.
    private var searchScope: String {
        if let folder = model.folder { return "\(folder.path):\(folder.files.joined(separator: ","))" }
        return model.view.fileName ?? ""
    }

    private var treeScope: String {
        model.folder?.path ?? "file"
    }

    var body: some View {
        VStack(spacing: 0) {
            header
                .zIndex(1)
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            if case .array(_, let count, let index, _) = model.view, count > 0 {
                Divider()
                PagerBar(index: index, count: count)
            }
        }
    }

    private var header: some View {
        HStack {
            if model.canSearch {
                SearchBarView()
                    .id(searchScope)
            }
            Spacer()
            if !model.version.isEmpty {
                Text("v\(model.version)")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    @ViewBuilder
    private var content: some View {
        switch model.view {
        case .empty:
            EmptyStateView()
        case .loading:
            CenterState {
                ProgressView()
                Text("Loading…").foregroundStyle(.secondary)
            }
        case .error(_, let message):
            ErrorStateView(message: message, offersOpen: model.folder == nil)
        case .value(let fileName, let value):
            // Keyed by origin + name so each file opens a fresh tree and
            // fold/expand state never leaks from a same-named file elsewhere.
            JsonTreeView(value: value)
                .id("\(treeScope):\(fileName)")
        case .array(let fileName, let count, let index, let item):
            if count == 0 {
                CenterState {
                    Text("This array is empty.").foregroundStyle(.secondary)
                }
            } else {
                ItemBodyView(item: item)
                    .id("\(treeScope):\(fileName):\(index)")
            }
        }
    }
}

struct ItemBodyView: View {
    let item: ItemState

    var body: some View {
        switch item {
        case .loading:
            CenterState {
                ProgressView()
                Text("Loading item…").foregroundStyle(.secondary)
            }
        case .error(let message):
            ErrorStateView(message: message, offersOpen: false)
        case .value(let value):
            JsonTreeView(value: value)
        }
    }
}

struct CenterState<Content: View>: View {
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(spacing: 12) {
            content()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

struct EmptyStateView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        CenterState {
            Text("{ }")
                .font(.system(size: 44, weight: .light, design: .monospaced))
                .foregroundStyle(.tertiary)
            Text("Open a folder to start reading JSON files")
                .foregroundStyle(.secondary)
            Button("Open Folder") { model.pickFolder() }
            Text("or press ⌘O")
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
    }
}

struct ErrorStateView: View {
    @Environment(AppModel.self) private var model
    let message: String
    let offersOpen: Bool

    var body: some View {
        CenterState {
            Text("Unable to read JSON")
                .font(.title3.weight(.semibold))
            Text(message)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 420)
            if offersOpen {
                Button("Open Folder") { model.pickFolder() }
            }
        }
        .padding()
    }
}
