# JSON Reader

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

Keyboard: `⌘/Ctrl+O` opens a folder; `←/↑/PageUp` and `→/↓/PageDown` move
between array items. Appearance follows the system light/dark setting.
