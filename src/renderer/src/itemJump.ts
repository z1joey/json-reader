export type ItemJump =
  | { kind: 'jump'; index: number }
  | { kind: 'invalid' }
  | { kind: 'noop' }

/**
 * Decides what committing a typed item number should do.
 *
 * - A number in `1..count` (surrounding whitespace and thousands separators
 *   tolerated) jumps to that item, as a 0-based index.
 * - Empty input is a no-op: clearing the field and pressing Enter just
 *   restores the current number.
 * - Anything else — text, decimals, signs, zero, out of range, or digits too
 *   large for a safe integer — is invalid and must never jump.
 */
export function parseItemJump(raw: string, count: number): ItemJump {
  const digits = raw.trim().replaceAll(',', '')
  if (!digits) return { kind: 'noop' }
  if (!/^\d+$/.test(digits)) return { kind: 'invalid' }
  const n = Number(digits)
  if (!Number.isSafeInteger(n) || n < 1 || n > count) return { kind: 'invalid' }
  return { kind: 'jump', index: n - 1 }
}
