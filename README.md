# JSON Reader

[![CI](https://github.com/z1joey/json-reader/actions/workflows/ci.yml/badge.svg)](https://github.com/z1joey/json-reader/actions/workflows/ci.yml)
[![Release](https://github.com/z1joey/json-reader/actions/workflows/release.yml/badge.svg)](https://github.com/z1joey/json-reader/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A minimal, read-only desktop viewer for JSON files, built for one job: making
large JSON pleasant to read.

Point it at a folder and read. Files whose root is a big array — exports,
dumps, logs, datasets — are shown one item at a time with keyboard paging, so
even multi-gigabyte files open instantly. Every other JSON value is rendered
as a structured, human-readable document.

## Highlights

- **Huge array files, opened instantly.** The file is streamed once through a
  byte-level scan that records only the byte range of each top-level element;
  an element is read and parsed only when you page to it. Navigating never
  re-reads the file, and memory stays flat no matter the file size.
- **Folder reading.** `⌘/Ctrl+O` opens a folder; its top-level `.json` files
  are listed in a sidebar, and `↑/↓` switch between them. A folder with a
  single JSON file behaves like a plain file open.
- **Search that ranks.** Case-insensitive search across every JSON file in
  the opened folder, ranked by match quality: exact string values first, then
  value prefixes, then any occurrence. Results show the file, the enclosing
  field, a highlighted snippet, and the item number; picking a result opens
  that file and jumps to that item.
- **A reader, not an editor.** Objects read as label/value entries, arrays as
  numbered lists, and nested groups fold behind a count summary — unusually
  large groups start collapsed so an item opens as a readable overview
  instead of a wall. Very long strings are truncated with a *Show all*
  button.
- **Keyboard-first.** Page through items, jump to an item by number, switch
  files, and search without touching the mouse.
- **Native and quiet.** Light/dark follows the system setting; the renderer
  is sandboxed with context isolation on and a strict content security
  policy. All file access lives in the main process.

## Download

Grab the latest `json-reader-<version>-arm64.dmg` from the
[Releases page](https://github.com/z1joey/json-reader/releases) (macOS,
Apple Silicon). Prebuilt packages currently cover macOS only; on Intel Macs,
Windows, or Linux, [run it from source](#development) instead.

The build is unsigned, so macOS Gatekeeper warns on first launch: right-click
the app and choose **Open** (only needed once), or run
`xattr -cr /Applications/json-reader.app`.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `⌘/Ctrl+O` | Open a folder |
| `⌘/Ctrl+F` | Focus search |
| `←` / `→` , `PageUp` / `PageDown` | Previous / next array item |
| `↑` / `↓` | Previous / next file in the opened folder |
| type a number, `Enter` | Jump to that array item |
| `↑` / `↓` , `Enter` , `Esc` | Navigate / pick / dismiss search results |

## Development

Requires Node.js 22+ and npm.

```sh
npm install
npm run dev      # develop with hot reload
npm run build    # production build into out/
npm start        # launch the built app
npm test         # unit tests
npm run typecheck
```

### Architecture

- **Main process** (`src/main`) — owns all file access. `jsonFile.ts` streams
  a file through a byte-level structural scan: when the root is an array it
  records only the byte range of each top-level element, then parses elements
  individually on demand. Opening a huge file never parses it all, and moving
  between items never re-reads the file.
- **Preload** (`src/preload`) — exposes the renderer-facing calls
  (`openFolder`, `openFile`, `getItem`, `search`, `onOpenFolderRequested`)
  over `contextBridge`, with `contextIsolation: true`, `nodeIntegration:
  false`, and `sandbox: true`.
- **Renderer** (`src/renderer`) — React app; renders the current value only.
  Search is folder-aware: results can come from any JSON file in the opened
  folder, and selecting a result jumps to that file.
- **Shared** (`src/shared`) — IPC response shapes used by both sides.

### CI and releases

Two GitHub Actions workflows live in `.github/workflows/`; run history is on
the [Actions tab](https://github.com/z1joey/json-reader/actions).

- **CI** (`ci.yml`) — runs on every push to `main` and every pull request:
  installs dependencies, then typechecks, runs the unit tests, and does a
  production build.
- **Release** (`release.yml`) — runs when a `v*` tag is pushed: verifies the
  tag matches the version in `package.json`, re-runs typecheck and tests,
  builds an unsigned macOS (Apple Silicon) `.dmg` with electron-builder, and
  publishes it as a GitHub Release.

The version in `package.json` is the single source of truth. To cut a
release:

1. Bump `version` in `package.json` and commit it.
2. Tag and push: `git tag v0.2.1 && git push origin v0.2.1`.
3. The Release workflow attaches `json-reader-0.2.1-arm64.dmg` to a GitHub
   Release with generated notes.

Re-releasing the same version requires deleting both the GitHub Release and
its tag first.

## Contributing

Issues and pull requests are welcome. Keep the app small and focused: it is a
reader, not an editor. A pull request should pass `npm run typecheck`,
`npm test`, and `npm run build`.

## License

[MIT](LICENSE) © Joey Zhang
