# JSON Reader

[![CI](https://github.com/z1joey/json-reader/actions/workflows/ci.yml/badge.svg)](https://github.com/z1joey/json-reader/actions/workflows/ci.yml)
[![Release](https://github.com/z1joey/json-reader/actions/workflows/release.yml/badge.svg)](https://github.com/z1joey/json-reader/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A minimal, read-only desktop viewer for JSON files — a native SwiftUI app for
macOS, built for one job: making large JSON pleasant to read.

Point it at a folder and read. Files whose root is a big array — exports,
dumps, logs, datasets — are shown one item at a time with keyboard paging, so
even multi-gigabyte files open instantly. Every other JSON value is rendered
as a structured, human-readable document.

## Highlights

- **Huge array files, opened instantly.** The file is streamed once through a
  byte-level scan that records only the byte range of each top-level element;
  an element is read and parsed only when you page to it. Navigating never
  re-reads the file, and memory stays flat no matter the file size.
- **Folder reading.** `⌘O` opens a folder; its top-level `.json` files are
  listed in a sidebar, and `↑/↓` switch between them. A folder with a single
  JSON file behaves like a plain file open. You can also pass a folder on the
  command line: `JSONReader -folder /path/to/folder`.
- **Search that ranks.** Case-insensitive search across every JSON file in
  the opened folder, ranked by match quality: exact string values first, then
  value prefixes, then any occurrence. Results show the file, the enclosing
  field, a highlighted snippet, and the item number; picking a result opens
  that file and jumps to that item. When the query extends the previous one,
  the earlier hits are re-verified instead of rescanning the file.
- **A reader, not an editor.** Objects read as label/value entries, arrays as
  numbered lists, and nested groups fold behind a count summary — unusually
  large groups start collapsed so an item opens as a readable overview
  instead of a wall. Each nesting level carries a thin depth-colored rule,
  and very long strings are truncated with a *Show all* button.
- **Keyboard-first.** Page through items, jump to an item by number, switch
  files, and search without touching the mouse.
- **Native and quiet.** A single SwiftUI window; light/dark follows the
  system setting; object keys keep their document order; the file is only
  ever read, never written.

## Download

Grab the latest `JSONReader-<version>-universal.dmg` from the
[Releases page](https://github.com/z1joey/json-reader/releases) (macOS 14+,
Apple Silicon and Intel).

The build carries an ad-hoc signature and is not notarized, so macOS
Gatekeeper warns on first launch — recent macOS versions may even claim the
app "is damaged". It isn't; the warning only reflects the missing Apple
notarization. After moving the app to `/Applications`, clear the download
quarantine once:

```sh
xattr -cr "/Applications/JSONReader.app"
```

Alternatively, use **Open Anyway** in System Settings → Privacy & Security.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `⌘O` | Open a folder |
| `⌘F` | Focus search |
| `←` / `→` , `PageUp` / `PageDown` (`⌘[` / `⌘]`) | Previous / next array item |
| `↑` / `↓` (`⌘⌥↑` / `⌘⌥↓`) | Previous / next file in the opened folder |
| type a number, `Enter` | Jump to that array item |
| `↑` / `↓` , `Enter` , `Esc` | Navigate / pick / dismiss search results |

## Development

Requires Xcode 16.3+ and macOS 14+ (the app itself targets macOS 14).

```sh
xcodebuild -project JSONReader.xcodeproj -scheme JSONReader \
    -destination 'platform=macOS' test     # build and run the unit tests
open JSONReader.xcodeproj                  # develop in Xcode (⌘R)
./scripts/make-dmg.sh                      # build a release dmg into dist/
```

During development you can launch straight into a folder:

```sh
open build/DerivedData/Build/Products/Debug/JSONReader.app --args -folder /some/json/folder
```

### Architecture

- **Engine** (`JSONReader/Engine`) — owns all file access.
  `JsonScanner` streams a file through a byte-level structural scan: when
  the root is an array it records only the byte range of each top-level
  element, and `JsonFile` (an actor) parses elements individually on demand.
  Opening a huge file never parses it all, and moving between items never
  re-reads the file. `RawJsonSearch` ranks matches over the raw UTF-8 text;
  `FolderSearcher` extends it across every JSON file in the folder, keeping
  analyzed files warm between queries. `JsonValueParser` produces
  order-preserving trees; `JsonPointer` addresses any node by RFC 6901
  pointer.
- **Logic** (`JSONReader/Logic`) — pure, UI-free decision rules: item-jump
  validation, the fold policy for large groups, file switching, and what
  picking a search hit should do.
- **Views** (`JSONReader/Views`) — the SwiftUI surface: split view with the
  file sidebar, the recursive foldable JSON tree, the pager with its editable
  item position, and the search field with its results dropdown.
- **AppModel** (`JSONReader/AppModel.swift`) — the reading session: folder
  state, file loading with last-write-wins queuing, item loads, search
  orchestration, and the global keyboard handling.

### Tests

The ported behavioral suite lives in `JSONReaderTests` (Swift Testing): the
byte scanner (chunk boundaries, BOMs, multibyte content, malformed input
line numbers), search ranking/memoization/cancellation, folder listing and
folder-wide search caches, JSON pointer resolution, and the pure logic rules.

### CI and releases

Two GitHub Actions workflows live in `.github/workflows/`; run history is on
the [Actions tab](https://github.com/z1joey/json-reader/actions).

- **CI** (`ci.yml`) — runs on every push to `main`/`swiftui` and every pull
  request: builds the app and runs the unit tests with `xcodebuild` on a
  macOS runner.
- **Release** (`release.yml`) — runs when a `v*` tag is pushed: verifies the
  tag matches `MARKETING_VERSION` in the project, re-runs the tests, packs a
  universal (Apple Silicon + Intel) `.dmg` with `scripts/make-dmg.sh`, and
  publishes it as a GitHub Release.

The version in `JSONReader.xcodeproj` (`MARKETING_VERSION`) is the single
source of truth. To cut a release:

1. Bump `MARKETING_VERSION` in `JSONReader.xcodeproj/project.pbxproj` and
   commit it.
2. Tag and push: `git tag v0.3.0 && git push origin v0.3.0`.
3. The Release workflow attaches `JSONReader-0.3.0-universal.dmg` to a
   GitHub Release with generated notes.

Re-releasing the same version requires deleting both the GitHub Release and
its tag first.

## Contributing

Issues and pull requests are welcome. Keep the app small and focused: it is a
reader, not an editor. A pull request should pass
`xcodebuild -scheme JSONReader -destination 'platform=macOS' test`.

## License

[MIT](LICENSE) © Joey Zhang
