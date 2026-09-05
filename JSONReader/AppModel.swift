import AppKit
import Foundation
import Observation

enum ItemState: Equatable {
    case loading
    case value(JsonValue)
    case error(String)
}

enum ViewState: Equatable {
    case empty
    case loading
    case array(fileName: String, count: Int, index: Int, item: ItemState)
    case value(fileName: String, value: JsonValue)
    case error(fileName: String, message: String)

    var fileName: String? {
        switch self {
        case .array(let fileName, _, _, _), .value(let fileName, _), .error(let fileName, _): return fileName
        case .empty, .loading: return nil
        }
    }

    var isArray: Bool {
        if case .array = self { return true }
        return false
    }
}

struct FolderState: Equatable {
    var name: String
    var path: String
    /// Display names of the folder's JSON files, in sidebar order.
    var files: [String]
    var activeIndex: Int
}

enum OpenResponse: Equatable {
    case canceled
    case ok(fileName: String, root: RootInfo)
    case folder(name: String, path: String, files: [String])
    case error(fileName: String, message: String)
}

enum OpenFileResponse: Equatable {
    case ok(fileName: String, root: RootInfo)
    case error(fileName: String, message: String)
}

enum SearchOutcome: Equatable {
    case ok(hits: [SearchHit], moreAvailable: Bool)
    case canceled
    case unsupported
    case error(String)
}

/// A monotonically increasing request number shared with in-flight searches
/// so a newer request retires the older scans without touching main-actor state.
final class SearchGeneration: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0

    var current: Int {
        lock.lock()
        defer { lock.unlock() }
        return value
    }

    func next() -> Int {
        lock.lock()
        defer { lock.unlock() }
        value += 1
        return value
    }
}

/// The whole reading session: the opened folder, the current file, the item
/// being read, and every keyboard-driven navigation rule.
@MainActor
@Observable
final class AppModel {
    var view: ViewState = .empty
    var folder: FolderState?
    /// Bumped whenever the search field should take focus (⌘F).
    var searchFocusToken = 0
    let version: String

    @ObservationIgnored private var currentFile: JsonFile?
    @ObservationIgnored private var currentFileName: String?
    @ObservationIgnored private var currentFolderPaths: [String]?
    @ObservationIgnored private let folderSearcher = FolderSearcher()
    @ObservationIgnored private let searchGeneration = SearchGeneration()
    // A file load is in flight; rapid clicks must read this synchronously.
    @ObservationIgnored private var isLoading = false
    @ObservationIgnored private var loadingFolderIndex: Int?
    // The latest panel click or search selection made while a load was in
    // flight (last write wins).
    @ObservationIgnored private var pendingFolderRequest: (index: Int, itemIndex: Int?)?
    // Replies for an item of a previously opened file are discarded.
    @ObservationIgnored private var fileGeneration = 0
    @ObservationIgnored private var keyMonitor: Any?
    @ObservationIgnored var showsOpenPanel: () async -> String? = AppModel.defaultOpenPanel

    init() {
        version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
    }

    // MARK: - Opening

    func pickFolder() {
        Task { await pickFolderAsync() }
    }

    func pickFolderAsync() async {
        if isLoading { return }
        let before = view
        isLoading = true
        view = .loading
        let picked = await showsOpenPanel()
        // A dialog open replaces the folder, so a queued panel click can no
        // longer be honored.
        pendingFolderRequest = nil
        guard let picked else {
            isLoading = false
            view = before
            return
        }
        await finishOpeningFolder(picked, restoring: before)
    }

    /// Opens `path` without a dialog, as when a folder arrives on the command
    /// line (`JSONReader -folder /path/to/folder`).
    func openFolder(at path: String) async {
        if isLoading { return }
        let before = view
        isLoading = true
        view = .loading
        pendingFolderRequest = nil
        await finishOpeningFolder(path, restoring: before)
    }

    /// Opens the folder passed as `-folder <path>` on the command line, if any.
    /// AppKit treats bare path arguments as documents to open (and then skips
    /// the default window), so the flag form is the one that works.
    func openLaunchArgumentIfPresent() {
        guard let path = UserDefaults.standard.string(forKey: "folder") else { return }
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory), isDirectory.boolValue else { return }
        Task { await openFolder(at: path) }
    }

    private func finishOpeningFolder(_ path: String, restoring before: ViewState) async {
        let result = await openFolderPath(path)
        switch result {
        case .canceled:
            isLoading = false
            view = before
        case .error(let fileName, let message):
            folder = nil
            view = .error(fileName: fileName, message: message)
            isLoading = false
        case .folder(let name, let path, let files):
            folder = FolderState(name: name, path: path, files: files, activeIndex: 0)
            isLoading = false
            await loadFolderFile(0)
        case .ok(let fileName, let root):
            folder = nil
            applyOpenedFile(fileName: fileName, root: root)
            isLoading = false
        }
    }

    private static func defaultOpenPanel() async -> String? {
        let panel = NSOpenPanel()
        panel.title = "Open folder"
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = "Open"
        let response = await panel.begin()
        guard response == .OK, let url = panel.url else { return nil }
        return url.path
    }

    /// Opens a folder whose top-level JSON files become the current folder.
    /// A single JSON file is opened directly; multiple files get a sidebar.
    func openFolderPath(_ path: String) async -> OpenResponse {
        let folderName = (path as NSString).lastPathComponent
        let names: [String]
        do {
            names = try FolderScan.listJsonFiles(in: path)
        } catch {
            return .error(fileName: folderName, message: "The folder could not be read.")
        }
        if names.isEmpty {
            await folderSearcher.clear()
            await closeCurrentFile()
            currentFileName = nil
            currentFolderPaths = nil
            return .error(fileName: folderName, message: "No JSON files found in this folder. Please choose another folder.")
        }
        // A single JSON file behaves like a plain file open: no folder panel.
        if names.count == 1 {
            await folderSearcher.clear()
            currentFolderPaths = nil
            switch await openJsonFile((path as NSString).appendingPathComponent(names[0])) {
            case .ok(let fileName, let root): return .ok(fileName: fileName, root: root)
            case .error(let fileName, let message): return .error(fileName: fileName, message: message)
            }
        }
        await folderSearcher.clear()
        currentFolderPaths = names.map { (path as NSString).appendingPathComponent($0) }
        return .folder(name: folderName, path: path, files: names)
    }

    /// Opens `path` as the current file, replacing whatever was open before.
    func openJsonFile(_ path: String) async -> OpenFileResponse {
        let fileName = (path as NSString).lastPathComponent
        await closeCurrentFile()
        do {
            let file = try await JsonFile.open(path: path)
            currentFile = file
            currentFileName = fileName
            fileGeneration += 1
            return .ok(fileName: fileName, root: await file.root)
        } catch {
            currentFile = nil
            currentFileName = nil
            let message = (error as? JsonError)?.message ?? "The file could not be read."
            return .error(fileName: fileName, message: message)
        }
    }

    private func closeCurrentFile() async {
        if let file = currentFile {
            currentFile = nil
            await file.close()
        }
    }

    private func applyOpenedFile(fileName: String, root: RootInfo) {
        switch root {
        case .array(let count):
            showItem(fileName: fileName, count: count, index: 0)
        case .value(let value):
            view = .value(fileName: fileName, value: value)
        }
    }

    // MARK: - Folder files

    func loadFolderFile(_ index: Int, itemIndex: Int? = nil) async {
        guard let paths = currentFolderPaths, index >= 0, index < paths.count else {
            view = .error(fileName: "", message: "No folder is open.")
            return
        }
        isLoading = true
        loadingFolderIndex = index
        folder?.activeIndex = index
        view = .loading
        let result = await openJsonFile(paths[index])
        switch result {
        case .ok(let fileName, let root):
            if let itemIndex, case .array(let count) = root, itemIndex >= 0, itemIndex < count {
                showItem(fileName: fileName, count: count, index: itemIndex)
            } else {
                applyOpenedFile(fileName: fileName, root: root)
            }
        case .error(let fileName, let message):
            view = .error(fileName: fileName, message: message)
        }
        // Last write wins: if another panel click arrived while this file was
        // opening, load it now instead of dropping it.
        loadingFolderIndex = nil
        isLoading = false
        if let pending = pendingFolderRequest {
            pendingFolderRequest = nil
            await loadFolderFile(pending.index, itemIndex: pending.itemIndex)
        }
    }

    func openFromFolder(_ index: Int, itemIndex: Int? = nil) {
        if isLoading {
            // A load is in flight: remember the latest request. Clicking the file
            // that is already loading is a no-op unless a specific item was asked.
            if loadingFolderIndex != index || itemIndex != nil {
                pendingFolderRequest = (index, itemIndex)
            }
            return
        }
        Task { await loadFolderFile(index, itemIndex: itemIndex) }
    }

    func switchFile(_ direction: SwitchDirection) {
        // The queued request outranks the in-flight load, which outranks the
        // last finished file — otherwise rapid presses collapse into one step.
        let activeIndex = FileSwitching.latestRequestedIndex(
            pending: pendingFolderRequest?.index,
            loading: loadingFolderIndex,
            settled: folder?.activeIndex
        )
        let decision = FileSwitching.decide(
            direction,
            folder: folder.map { FileSwitchFolder(fileCount: $0.files.count, activeIndex: activeIndex) }
        )
        if case .open(let index) = decision { openFromFolder(index) }
    }

    // MARK: - Items

    private func showItem(fileName: String, count: Int, index: Int) {
        view = .array(fileName: fileName, count: count, index: index, item: .loading)
        loadItem(index)
    }

    private func loadItem(_ index: Int) {
        guard let file = currentFile else { return }
        let generation = fileGeneration
        Task { [weak self] in
            let result: ItemState
            do {
                result = .value(try await file.item(index))
            } catch let error as JsonError {
                result = .error(error.message)
            } catch {
                result = .error("Item \(index + 1) could not be read.")
            }
            guard let self, self.fileGeneration == generation,
                  case .array(let fileName, let count, let current, _) = self.view, current == index else { return }
            self.view = .array(fileName: fileName, count: count, index: index, item: result)
        }
    }

    /// Moves to another item of the current array. A move to the position
    /// already shown must not restart the item load.
    func jumpTo(_ index: Int) {
        guard case .array(let fileName, let count, let current, _) = view,
              index >= 0, index < count, index != current else { return }
        showItem(fileName: fileName, count: count, index: index)
    }

    func goPrevious() {
        if case .array(_, _, let index, _) = view, index > 0 { jumpTo(index - 1) }
    }

    func goNext() {
        if case .array(_, let count, let index, _) = view, index < count - 1 { jumpTo(index + 1) }
    }

    // MARK: - Search

    var canSearch: Bool {
        if folder != nil { return true }
        if case .array(_, let count, _, _) = view, count > 0 { return true }
        return false
    }

    func requestSearchFocus() {
        if canSearch { searchFocusToken += 1 }
    }

    /// Searches the currently open folder (or the current file when no folder
    /// is open) for a case-insensitive substring, returning at most ten hits
    /// ranked by match quality. Each new request invalidates the previous
    /// scan, so fast typing never queues up stale full-file passes.
    func search(_ query: String) async -> SearchOutcome {
        let sequence = searchGeneration.next()
        let generation = searchGeneration
        let isCanceled: @Sendable () -> Bool = { generation.current != sequence }
        if let paths = currentFolderPaths, !paths.isEmpty {
            switch await folderSearcher.search(query, files: paths, isCanceled: isCanceled) {
            case .ok(let hits, let moreAvailable): return .ok(hits: hits, moreAvailable: moreAvailable)
            case .canceled: return .canceled
            case .unsupported: return .unsupported
            }
        }
        // Snapshot the file and its name: a file switch mid-search must neither
        // crash the old scan nor relabel its hits with the new file's name.
        guard let file = currentFile, let fileName = currentFileName, await file.searchable else { return .unsupported }
        do {
            guard let result = try await file.search(query, isCanceled: isCanceled) else { return .canceled }
            return .ok(
                hits: result.hits.map { SearchHit(base: $0, fileIndex: 0, fileName: fileName) },
                moreAvailable: result.moreAvailable
            )
        } catch {
            return .error((error as? JsonError)?.message ?? "The search could not be completed.")
        }
    }

    func handleSearchSelect(_ hit: SearchHit) {
        let decision = SearchSelection.decide(
            hit: hit,
            folder: folder.map { SelectFolder(fileCount: $0.files.count, activeIndex: $0.activeIndex) },
            loading: isLoading,
            viewIsArray: view.isArray
        )
        switch decision {
        case .open(let index, let itemIndex): openFromFolder(index, itemIndex: itemIndex)
        case .jump(let itemIndex): jumpTo(itemIndex)
        case .none: break
        }
    }

    // MARK: - Keyboard

    /// The whole app is keyboard-driven: no element needs focus for paging or
    /// file switching to work, so a local monitor sees every key first.
    func installKeyMonitor() {
        guard keyMonitor == nil else { return }
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self else { return event }
            return self.handleKeyDown(event) ? nil : event
        }
    }

    /// Returns true when the key was consumed.
    func handleKeyDown(_ event: NSEvent) -> Bool {
        if event.modifierFlags.intersection([.command, .control, .option]) != [] { return false }
        // Keys typed into a dialog, sheet, or text field belong to it, not the pager.
        if NSApp.modalWindow != nil || event.window is NSPanel || event.window?.sheetParent != nil { return false }
        if let responder = event.window?.firstResponder, responder is NSTextView || responder is NSTextField { return false }
        guard let key = event.specialKey else { return false }
        switch key {
        case .upArrow:
            switchFile(.previous)
            return folder != nil
        case .downArrow:
            switchFile(.next)
            return folder != nil
        case .leftArrow, .pageUp:
            guard view.isArray else { return false }
            goPrevious()
            return true
        case .rightArrow, .pageDown:
            guard view.isArray else { return false }
            goNext()
            return true
        default:
            return false
        }
    }
}
