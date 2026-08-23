# Plan: Folder Support + Single "Open JSON" Button

## Summary

Extend JSON Reader so the open dialog accepts **either a single `.json` file or a folder**:

- Folder with **0** JSON files → error state suggesting the user choose another folder.
- Folder with **1** JSON file → opens it directly (no panel).
- Folder with **multiple** JSON files → a **left sidebar panel** lists the files; the first file auto-opens and is highlighted; clicking another file switches to it (confirmed decisions: top-level scan only, auto-open first file, validity = `.json` extension).
- Remove the **top-right "Open JSON" button** in the header; keep the centered one on the entrance (empty) screen.

## Current State Analysis

Electron app (electron-vite + React 19 + TS), three layers:

- **Main** — [src/main/index.ts](file:///Users/joey/Projects/json-reader/src/main/index.ts)
  - `json:open` IPC (L76–105): native `dialog.showOpenDialog` with `properties: ['openFile']`, `.json` filter, opens ONE file via `JsonFile.open(path)`, returns `OpenResponse`. Module state: `currentFile: JsonFile | null`.
  - Menu "Open JSON…" (Cmd/Ctrl+O) sends `open-json-requested` to renderer.
- **Shared contract** — [src/shared/types.ts](file:///Users/joey/Projects/json-reader/src/shared/types.ts): `OpenResponse = canceled | ok | error`, `JsonReaderApi` (`open`, `getItem`, `search`, `onOpenRequested`).
- **Preload** — [src/preload/index.ts](file:///Users/joey/Projects/json-reader/src/preload/index.ts): thin `ipcRenderer.invoke` bridge.
- **Renderer** — [src/renderer/src/App.tsx](file:///Users/joey/Projects/json-reader/src/renderer/src/App.tsx)
  - State machine `empty | loading | array | value | error`; `openFile()` drives the dialog.
  - Header renders a top-right "Open JSON" button (L145–147) — **to remove**.
  - `EmptyState` (L208–221) renders the centered "Open JSON" button — **to keep**.
  - `ErrorState` (L223–235) has an optional "Open JSON" button (shown when `onOpen != null`).
- **Styles** — [src/renderer/src/index.css](file:///Users/joey/Projects/json-reader/src/renderer/src/index.css): `.app` is a column flex (header / `.content` / `.footer`); `.header .button { -webkit-app-region: no-drag }` rule exists only for the header button being removed. Search popup pattern (panel bg + active row bg) is the style reference for the new sidebar.
- Tests: `vitest` (`npm run test`), only [src/main/jsonFile.test.ts](file:///Users/joey/Projects/json-reader/src/main/jsonFile.test.ts) exists. Typecheck: `npm run typecheck`. Dev run: `npm run dev`.

## Proposed Changes

### 1. `src/shared/types.ts` — extend the contract

```ts
export type OpenResponse =
  | { status: 'canceled' }
  | { status: 'ok'; fileName: string; root: RootInfo }
  | { status: 'folder'; folderName: string; files: string[] } // NEW: display names only (no paths)
  | { status: 'error'; fileName: string; error: string }

export type OpenFileResponse =
  | { status: 'ok'; fileName: string; root: RootInfo }
  | { status: 'error'; fileName: string; error: string }

export interface JsonReaderApi {
  open: () => Promise<OpenResponse>
  openFile: (index: number) => Promise<OpenFileResponse> // NEW: open a file from the current folder by index
  // getItem / search / onOpenRequested unchanged
}
```

Rationale: paths never cross the sandboxed bridge — the main process remembers the folder's full paths and the renderer addresses files by index.

### 2. `src/preload/index.ts` — bridge the new call

Add `openFile: (index: number) => ipcRenderer.invoke('json:open-file', index)` to the exposed API. (`env.d.ts` types `window.jsonReader` from `JsonReaderApi`, so it needs no change.)

### 3. `src/main/index.ts` — folder-aware open + file switching

**New module state:** `let currentFolderFiles: string[] | null = null` (absolute paths, display order).

**Rewrite the `json:open` handler:**

1. Dialog options: `properties: ['openFile', 'openDirectory']` (keep title + JSON/All-Files filters). Canceled → `{ status: 'canceled' }` (no state mutated, so the renderer can restore).
2. `stat(path)` (from `node:fs/promises`) to tell file vs. directory; stat failure → generic error response.
3. **File branch** (unchanged behavior + folder reset): validate `.json` extension, `await closeCurrentFile()`, `currentFolderFiles = null`, open via `JsonFile.open`, return `ok | error` exactly as today.
4. **Directory branch:**
   - `readdir(dir, { withFileTypes: true })`; keep entries where `dirent.isFile() && !dirent.name.startsWith('.') && /\.json$/i.test(dirent.name)`; sort with `name.localeCompare(...)`; build full paths via `join(dir, name)`.
   - **0 files** → `await closeCurrentFile()`, `currentFolderFiles = null`, return `{ status: 'error', fileName: basename(dir), error: 'No JSON files found in this folder. Please choose another folder.' }`.
   - **1 file** → same as the file branch on that path (opens directly, `currentFolderFiles = null`, no panel).
   - **2+ files** → `currentFolderFiles = paths`, return `{ status: 'folder', folderName: basename(dir), files: names }`. The renderer then auto-opens index 0.

**New `json:open-file` handler:**

```ts
ipcMain.handle('json:open-file', (_event, index: unknown): Promise<OpenFileResponse> => {
  // validate: currentFolderFiles != null, index is an in-range integer
  // otherwise: { status: 'error', fileName: '', error: 'No folder is open.' }
  // await closeCurrentFile(); try JsonFile.open(currentFolderFiles[index])
  // ok → { status: 'ok', fileName: basename(path), root }
  // error → currentFile = null, keep currentFolderFiles, return error
})
```

Keeping `currentFolderFiles` on error lets the user pick a different file from the panel. `closeCurrentFile()` on window close is unchanged.

### 4. `src/renderer/src/FilePanel.tsx` — NEW sidebar component

```tsx
type Props = {
  name: string
  files: string[]          // display names
  activeIndex: number
  onSelect: (index: number) => void
}

// <aside className="file-panel">
//   <div className="file-panel-title" title={name}>{name}</div>
//   <ul className="file-list">
//     {files.map((file, i) => (
//       <li key={file}>
//         <button className={`file-item${i === activeIndex ? ' active' : ''}`}
//                 title={file} onClick={() => onSelect(i)}>{file}</button>
//       </li>
//     ))}
//   </ul>
// </aside>
```

Names are basenames so they are unique within a folder (`key={file}` is safe). Real `<button>`s for keyboard access, with the standard `.button:focus-visible` outline pattern.

### 5. `src/renderer/src/App.tsx` — state, flows, layout, button removal

**Remove** the header "Open JSON" button (L145–147).

**New state** (kept separate from the view state so the panel persists across file switches):

```ts
type FolderState = { name: string; files: string[]; activeIndex: number }
const [folder, setFolder] = useState<FolderState | null>(null)
```

The existing `State` union is unchanged (no new view needed — auto-open means a folder always transitions straight into `loading → array/value/error`).

**Rename** the dialog-opener `openFile` → `pick` (it now opens files *or* folders); add:

```ts
const openFromFolder = useCallback(async (index: number) => {
  if (stateRef.current.view === 'loading') return
  setFolder((f) => (f ? { ...f, activeIndex: index } : f)) // immediate highlight
  setState({ view: 'loading' })
  const result = await jsonReader.openFile(index)
  // ok → array/value state (same mapping as pick()'s ok branch)
  // error → { view: 'error', fileName, message } (panel stays)
}, [])
```

**`pick()` result handling:**

- `canceled` → restore `before` (unchanged).
- `error` → error state **and** `setFolder(null)` (a failed new pick discards the old panel).
- `ok` → `setFolder(null)` + array/value state (unchanged mapping).
- `folder` (new) → `setFolder({ name, files, activeIndex: 0 })` then `void openFromFolder(0)` (auto-open first file).

**Layout** — wrap the content in a row so the panel sits beside it:

```tsx
<div className="app">
  <header className="header">… /* no button anymore */ …</header>
  <div className="body">
    {folder && <FilePanel name={folder.name} files={folder.files}
      activeIndex={folder.activeIndex} onSelect={(i) => void openFromFolder(i)} />}
    <main className="content">…existing views…</main>
  </div>
  {/* footer unchanged */}
</div>
```

**ErrorState wiring:** `onOpen={folder ? null : () => void pick()}` — when the panel is visible the panel itself is the escape hatch (no button); for dialog-level errors (e.g. empty folder) the "Open JSON" button reopens the dialog, and the message text carries the "choose another folder" suggestion. Button label stays "Open JSON" everywhere.

**Copy tweak** in `EmptyState`: "Open a JSON file or folder to start reading" (hint `⌘O` unchanged). Everything else — keyboard handling, search, pager, document title — works unchanged because it keys off the existing view state.

### 6. `src/renderer/src/index.css` — sidebar styles + cleanup

- Add `.body { display: flex; flex: 1; min-height: 0; }`; keep `.content { flex: 1; overflow-y: auto; }` (add `min-width: 0`).
- Sidebar, mirroring the search-popup aesthetic (panel background, quiet active row):

```css
.file-panel { width: 232px; flex: none; background: var(--panel);
  border-right: 1px solid var(--hairline); overflow-y: auto; }
.file-panel-title { padding: 14px 16px 10px; font-size: 11px; font-weight: 600;
  letter-spacing: 0.07em; text-transform: uppercase; color: var(--key);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.file-list { list-style: none; margin: 0; padding: 6px;
  display: flex; flex-direction: column; gap: 2px; }
.file-item { display: block; width: 100%; text-align: left; font: inherit;
  font-size: 13px; color: var(--fg); background: none; border: none;
  border-radius: 6px; padding: 6px 10px; cursor: pointer;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.file-item:hover { background: var(--bg); }
.file-item.active { background: var(--bg); color: var(--accent); font-weight: 600; }
.file-item:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
```

- **Remove** the now-dead `.header .button { -webkit-app-region: no-drag; }` rule (no button remains in the header).

## Assumptions & Decisions

- **Scan depth:** top level of the selected folder only (no recursion) — confirmed by user.
- **Auto-open:** first file (alphabetically) opens immediately when a folder has 2+ files — confirmed by user.
- **Validity:** a `.json` extension makes a file "valid" for listing; malformed files surface their parse error only when opened — confirmed by user. Hidden dotfiles (`*.json` starting with `.`) are excluded from the list.
- **Sort order:** `localeCompare` on the file name (case-friendly alphabetical).
- **1-file folders** open that file directly with no panel (panel is specified for "multiple" files only).
- **No new views** in the renderer state machine — the folder is a separate `folder` state, so search/pager/title logic is untouched.
- **Security:** full paths stay in the main process; only display names + indexes cross the preload bridge.
- Menu label "Open JSON…" and the `⌘O` accelerator stay as-is (they now also accept folders).

## Verification

1. `npm run typecheck` — both tsconfigs pass.
2. `npm run test` — existing vitest suite still green.
3. `npm run dev` manual smoke test:
   - Entrance screen shows exactly ONE "Open JSON" button (center); header has none.
   - Open a single `.json` file → renders as before.
   - Open a folder with no `.json` files → error "No JSON files found in this folder. Please choose another folder." with a working "Open JSON" button to retry.
   - Open a folder with exactly one `.json` file → opens directly, no sidebar.
   - Open a folder with several `.json` files → sidebar lists them (alphabetical, dotfiles hidden), first file auto-opened and highlighted; clicking another file switches content; search (`⌘F`) and the pager work per file; window title follows the active file.
   - Folder containing a malformed `.json` file → error view, sidebar remains, picking another file recovers.
   - `⌘O` / menu open still works; canceling the dialog restores the previous view (and panel).
   - Sidebar looks right in dark and light appearances.
