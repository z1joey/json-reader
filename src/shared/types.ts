/** Shapes shared between the main process, the preload bridge and the renderer. */

export type RootInfo = { type: 'array'; count: number } | { type: 'value'; value: unknown }

export type OpenResponse =
  | { status: 'canceled' }
  | { status: 'ok'; fileName: string; root: RootInfo }
  | { status: 'error'; fileName: string; error: string }

export type ItemResponse = { status: 'ok'; value: unknown } | { status: 'error'; error: string }

export interface JsonReaderApi {
  /** Shows the open-file dialog, then loads and analyzes the chosen file. */
  open: () => Promise<OpenResponse>
  /** Parses one top-level element of an array-root file on demand. */
  getItem: (index: number) => Promise<ItemResponse>
  /** Fired when the user opens a file via the menu (Cmd/Ctrl+O). */
  onOpenRequested: (callback: () => void) => () => void
}
