/** Shapes shared between the main process, the preload bridge and the renderer. */

export type RootInfo = { type: 'array'; count: number } | { type: 'value'; value: unknown }

export type OpenResponse =
  | { status: 'canceled' }
  | { status: 'ok'; fileName: string; root: RootInfo }
  | { status: 'folder'; folderName: string; files: string[] }
  | { status: 'error'; fileName: string; error: string }

export type OpenFileResponse =
  | { status: 'ok'; fileName: string; root: RootInfo }
  | { status: 'error'; fileName: string; error: string }

export type ItemResponse = { status: 'ok'; value: unknown } | { status: 'error'; error: string }

/**
 * How directly an element matches a search query:
 * 1 = some JSON string value equals the query,
 * 2 = some string value starts with the query,
 * 3 = the query appears anywhere in the element's text.
 */
export type SearchTier = 1 | 2 | 3

/** A search hit inside one JSON file, before file identity is attached. */
export type SearchHitBase = {
  /** Index of the matching top-level element inside that file. */
  index: number
  tier: SearchTier
  /** Name of the field enclosing the first match, when detectable. */
  field: string | null
  /** Short excerpt of the element's raw text around the first match. */
  snippet: string
  /** Offset of the matched query inside `snippet`, for highlighting. */
  matchStart: number
  /** Length of the matched query inside `snippet`. */
  matchLength: number
}

export type SearchHit = SearchHitBase & {
  /** Index of the file in the currently opened folder. */
  fileIndex: number
  /** Display name of the file containing the hit. */
  fileName: string
}

export type SearchResponse =
  | { status: 'ok'; hits: SearchHit[]; moreAvailable: boolean }
  | { status: 'canceled' }
  | { status: 'unsupported' }
  | { status: 'error'; message: string }

export interface JsonReaderApi {
  /** Shows the open-folder dialog and loads the folder's JSON files. */
  openFolder: () => Promise<OpenResponse>
  /** Loads the file at `index` of the folder opened most recently. */
  openFile: (index: number) => Promise<OpenFileResponse>
  /** Parses one top-level element of an array-root file on demand. */
  getItem: (index: number) => Promise<ItemResponse>
  /**
   * Searches the currently open folder (or the current file when no folder
   * is open) for a case-insensitive substring, returning at most ten hits
   * ranked by match quality.
   */
  search: (query: string) => Promise<SearchResponse>
  /** Fired when the user opens a folder via the menu (Cmd/Ctrl+O). */
  onOpenFolderRequested: (callback: () => void) => () => void
  /** The app version declared in package.json (e.g. "0.1.0"). */
  getVersion: () => Promise<string>
}
