/** Groups larger than this many items/entries start collapsed. */
export const LARGE_GROUP = 20

/**
 * Decides whether a group starts collapsed when an item first opens:
 * only unusually large groups hide their content behind a click; small
 * ones stay readable without interaction.
 */
export function shouldCollapse(count: number): boolean {
  return count > LARGE_GROUP
}
