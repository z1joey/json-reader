# JSON Reader

[![CI](https://github.com/z1joey/json-reader/actions/workflows/ci.yml/badge.svg)](https://github.com/z1joey/json-reader/actions/workflows/ci.yml)
[![Release](https://github.com/z1joey/json-reader/actions/workflows/release.yml/badge.svg)](https://github.com/z1joey/json-reader/actions/workflows/release.yml)

A minimal, read-only desktop viewer for JSON files, built for one job: making
large JSON pleasant to read. Large root arrays are shown one item at a time
with keyboard navigation; every other JSON value is rendered as a structured,
human-readable document.

## Running it

```sh
npm install
npm run dev      # develop with hot reload
npm run build    # production build into out/
npm start        # launch the built app
npm test         # unit tests for the JSON indexer
npm run typecheck
```

## Workflows

Two GitHub Actions workflows live in `.github/workflows/`; run history is on
the [Actions tab](https://github.com/z1joey/json-reader/actions).

- **CI** (`ci.yml`) — runs on every push to `main` and every pull request:
  installs dependencies, then typechecks, runs the unit tests, and does a
  production build. Superseded runs on the same branch are cancelled
  automatically.
- **Release** (`release.yml`) — runs when a `v*` tag is pushed: verifies the
  tag matches the version in `package.json`, re-runs typecheck and tests,
  builds an unsigned macOS (Apple Silicon) `.dmg` with electron-builder, and
  publishes it as a GitHub Release.

## Releases

The version in `package.json` is the single source of truth. To cut a
release:

1. Bump `version` in `package.json` and commit it.
2. Tag and push: `git tag v0.2.0 && git push origin v0.2.0`.
3. The Release workflow attaches `json-reader-0.2.0-arm64.dmg` to a GitHub
   Release with generated notes.

The dmg is unsigned, so macOS Gatekeeper warns on first launch: right-click
the app and choose **Open** (only needed once), or run
`xattr -cr /Applications/json-reader.app`. Re-releasing the same version
requires deleting both the GitHub Release and its tag first.

## Architecture

- **Main process** (`src/main`) — owns all file access. `jsonFile.ts` streams
  a file through a byte-level structural scan: when the root is an array it
  records only the byte range of each top-level element, then parses elements
  individually on demand. Opening a huge file never parses it all, and moving
  between items never re-reads the file.
- **Preload** (`src/preload`) — exposes the renderer-facing calls
  (`openFolder`, `openFile`, `getItem`, `search`, `onOpenFolderRequested`)
  over `contextBridge`.
  `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
- **Renderer** (`src/renderer`) — React app; renders the current value only.
  Opening a folder lists its top-level `.json` files in a sidebar and loads
  the selected file. Search is folder-aware: results can come from any JSON
  file in the opened folder, and selecting a result jumps to that file.

Keyboard: `⌘/Ctrl+O` opens a folder; `←/→/PageUp/PageDown` move between array
items of the open file; with a folder holding more than one file, `↑/↓` move
between its files. Appearance follows the system light/dark setting.
