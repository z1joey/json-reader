/**
 * A location inside a JSON value: object keys by name, array elements by
 * index, in document order (e.g. `["results", 2, "message"]`).
 */
export type JsonPath = (string | number)[]

/**
 * A stable string identity for a path, used to key annotated locations in
 * sets and to detect duplicate annotations of the same spot. String keys
 * are quoted so they can never collide with numeric indices or each other.
 */
export function pathKey(path: readonly (string | number)[] | null): string {
  if (path === null) return ''
  return path
    .map((segment) => (typeof segment === 'number' ? `#${segment}` : JSON.stringify(segment)))
    .join('.')
}
