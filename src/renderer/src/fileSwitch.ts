export type FileSwitchFolder = { fileCount: number; activeIndex: number }

export type FileSwitchDecision = { kind: 'open'; index: number } | { kind: 'none' }

/**
 * Decides what an Up/Down arrow press should do.
 *
 * File switching only exists while a folder with more than one file is open;
 * with zero or one file there is nothing to switch to, so the keys do
 * nothing. The index never wraps past the first or last file.
 */
export function decideFileSwitch(direction: 'previous' | 'next', folder: FileSwitchFolder | null): FileSwitchDecision {
  if (!folder || folder.fileCount < 2) return { kind: 'none' }
  const index = direction === 'previous' ? folder.activeIndex - 1 : folder.activeIndex + 1
  if (index < 0 || index >= folder.fileCount) return { kind: 'none' }
  return { kind: 'open', index }
}

/**
 * The freshest requested file position: a queued panel/keyboard request
 * outranks the in-flight load, which outranks the last finished file.
 * Reading only the in-flight load makes rapid presses recompute the same
 * step and collapse into one. `-1` means nothing was ever requested.
 */
export function latestRequestedIndex(pending: number | null, loading: number | null, settled: number | undefined): number {
  return pending ?? loading ?? settled ?? -1
}
