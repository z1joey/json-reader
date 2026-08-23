import type { SearchHit } from '../../shared/types'

export type SelectFolder = { files: string[]; activeIndex: number }

export type SearchSelectDecision =
  | { kind: 'open'; index: number; itemIndex: number }
  | { kind: 'jump'; itemIndex: number }
  | { kind: 'none' }

/**
 * Decides what selecting a search hit should do.
 *
 * - A hit in a file other than the active one opens that file and jumps to
 *   the hit's item.
 * - A hit in the active file jumps straight to the item — unless that file
 *   is still loading, where the open machinery's last-write-wins queue must
 *   take the request instead (the plain jump is a no-op on the 'loading'
 *   view, so the hit would otherwise be dropped).
 * - Without a folder, a hit only matters when the current view is an array.
 */
export function decideSearchSelect(
  hit: SearchHit,
  folder: SelectFolder | null,
  loading: boolean,
  viewIsArray: boolean
): SearchSelectDecision {
  if (folder && hit.fileIndex >= 0 && hit.fileIndex < folder.files.length) {
    const sameFile = hit.fileIndex === folder.activeIndex
    if (!sameFile || loading) return { kind: 'open', index: hit.fileIndex, itemIndex: hit.index }
  }
  if (viewIsArray) return { kind: 'jump', itemIndex: hit.index }
  return { kind: 'none' }
}
