import SwiftUI

@main
struct JSONReaderApp: App {
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup("JSON Reader", id: "main") {
            ContentView()
                .environment(model)
                .frame(minWidth: 640, minHeight: 480)
                .onAppear {
                    model.installKeyMonitor()
                    model.openLaunchArgumentIfPresent()
                }
        }
        .defaultSize(width: 1000, height: 720)
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("Open Folder…") { model.pickFolder() }
                    .keyboardShortcut("o", modifiers: .command)
            }
            CommandGroup(after: .pasteboard) {
                Divider()
                Button("Search Items") { model.requestSearchFocus() }
                    .keyboardShortcut("f", modifiers: .command)
                    .disabled(!model.canSearch)
            }
            CommandMenu("Go") {
                Button("Previous Item") { model.goPrevious() }
                    .keyboardShortcut("[", modifiers: .command)
                    .disabled(!model.view.isArray)
                Button("Next Item") { model.goNext() }
                    .keyboardShortcut("]", modifiers: .command)
                    .disabled(!model.view.isArray)
                Divider()
                Button("Previous File") { model.switchFile(.previous) }
                    .keyboardShortcut(.upArrow, modifiers: [.command, .option])
                    .disabled(model.folder == nil)
                Button("Next File") { model.switchFile(.next) }
                    .keyboardShortcut(.downArrow, modifiers: [.command, .option])
                    .disabled(model.folder == nil)
            }
        }
    }
}
