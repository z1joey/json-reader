/** Shapes shared between the main process, the preload bridge and the renderer. */

import type { JsonPath } from './annotationPath'

export type { JsonPath } from './annotationPath'

export type RootInfo = { type: 'array'; count: number } | { type: 'value'; value: unknown }

export type OpenResponse =
  | { status: 'canceled' }
  | { status: 'ok'; fileName: string; root: RootInfo }
  | { status: 'folder'; folderName: string; files: string[] }
  | { status: 'error'; fileName: string; error: string; annotatable?: boolean }

export type OpenFileResponse =
  | { status: 'ok'; fileName: string; root: RootInfo }
  | { status: 'error'; fileName: string; error: string; annotatable?: boolean }

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

/**
 * One flagged location in a JSON file: an error the reader wants to record,
 * or any value worth marking while reading. Annotations live in a sidecar
 * file, one per source file (see `AnnotationList`).
 */
export type Annotation = {
  /** Unique id of this annotation. */
  id: string
  /**
   * Zero-based index of the annotated top-level element in an array-root
   * file; null for value-root files or the file as a whole.
   */
  itemIndex: number | null
  /**
   * Location of the annotated value inside the item (or the document):
   * object keys by name, array elements by index. null marks the item or
   * file itself — typically an item that failed to parse.
   */
  path: JsonPath | null
  /** 1-based line in the source file where the annotated value starts. */
  line: number | null
  /** Absolute byte offset of the annotated value in the source file. */
  byteOffset: number | null
  /** Short excerpt of the annotated value's raw JSON text. */
  snippet: string | null
  /** The recorded error message, or a fallback derived from the snippet. */
  message: string
  /** ISO timestamp of the moment the annotation was created. */
  createdAt: string
}

/** The sidecar document stored next to a source file as `<name>.annotations.json`. */
export type AnnotationList = {
  version: 1
  /** Display name of the source file the annotations belong to. */
  sourceFile: string
  createdAt: string
  updatedAt: string
  annotations: Annotation[]
}

export type AddAnnotationRequest = {
  /**
   * Index of the source file in the opened folder, or null to annotate the
   * single file that is currently open.
   */
  fileIndex: number | null
  itemIndex: number | null
  path: JsonPath | null
  /** The error message to record; when empty, the value's excerpt is used. */
  message: string
}

export type RemoveAnnotationRequest = {
  fileIndex: number | null
  itemIndex: number | null
  path: JsonPath | null
}

export type AnnotationsResponse =
  | { status: 'ok'; annotations: Annotation[] }
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
  /** Loads every annotation recorded for one file of the opened folder. */
  getAnnotations: (fileIndex: number | null) => Promise<AnnotationsResponse>
  /** Records an annotation in the source file's sidecar file. */
  addAnnotation: (request: AddAnnotationRequest) => Promise<AnnotationsResponse>
  /** Drops the annotation at the given location; removing a missing one is a no-op. */
  removeAnnotation: (request: RemoveAnnotationRequest) => Promise<AnnotationsResponse>
  /** Fired when the user opens a folder via the menu (Cmd/Ctrl+O). */
  onOpenFolderRequested: (callback: () => void) => () => void
  /** The app version declared in package.json (e.g. "0.1.0"). */
  getVersion: () => Promise<string>
}
