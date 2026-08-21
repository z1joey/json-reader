/** Shapes shared between the main process, the preload bridge and the renderer. */

export type RootInfo = { type: 'array'; count: number } | { type: 'value'; value: unknown }

export type OpenResponse =
  | { status: 'canceled' }
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

export type SearchHit = {
  /** Index of the matching top-level element. */
  index: number
  tier: SearchTier
  /** Name of the field enclosing the first match, when detectable. */
  field: string | null
  /** Short excerpt of the element's raw text around the first match. */
  snippet: string
}

export type SearchResponse =
  | { status: 'ok'; hits: SearchHit[]; moreAvailable: boolean }
  | { status: 'canceled' }
  | { status: 'unsupported' }
  | { status: 'error'; message: string }

export interface JsonReaderApi {
  /** Shows the open-file dialog, then loads and analyzes the chosen file. */
  open: () => Promise<OpenResponse>
  /** Parses one top-level element of an array-root file on demand. */
  getItem: (index: number) => Promise<ItemResponse>
  /**
   * Searches the elements of an array-root file for a case-insensitive
   * substring, returning at most ten hits ranked by match quality.
   */
  search: (query: string) => Promise<SearchResponse>
  /** Fired when the user opens a file via the menu (Cmd/Ctrl+O). */
  onOpenRequested: (callback: () => void) => () => void
}
