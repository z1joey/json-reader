import type { Annotation, JsonPath } from '../../shared/types'
import { pathKey } from '../../shared/annotationPath'

/**
 * Annotations that belong to the item (or file) currently shown: item
 * annotations carry that item's index, file-level ones use null.
 */
export function annotationsForItem(annotations: Annotation[], itemIndex: number | null): Annotation[] {
  return annotations.filter((annotation) => annotation.itemIndex === itemIndex)
}

/**
 * The set of annotated location keys for one item's view, used to highlight
 * the annotated entries while the item renders.
 */
export function annotatedKeys(annotations: Annotation[], itemIndex: number | null): Set<string> {
  return new Set(annotationsForItem(annotations, itemIndex).map((annotation) => pathKey(annotation.path)))
}

/** True when the location already carries an annotation. */
export function isAnnotated(annotations: Annotation[], itemIndex: number | null, path: JsonPath | null): boolean {
  const key = pathKey(path)
  return annotations.some((annotation) => annotation.itemIndex === itemIndex && pathKey(annotation.path) === key)
}

export type AnnotationToggleDecision = { kind: 'add' } | { kind: 'remove' }

/**
 * Decides what pressing the annotate control at a location must do:
 * annotate an unannotated spot, remove an existing annotation otherwise.
 */
export function decideAnnotationToggle(
  annotations: Annotation[],
  itemIndex: number | null,
  path: JsonPath | null
): AnnotationToggleDecision {
  return isAnnotated(annotations, itemIndex, path) ? { kind: 'remove' } : { kind: 'add' }
}
