import { useState, type ReactNode } from 'react'
import { shouldCollapse } from './collapse'
import type { JsonPath } from '../../shared/types'
import { pathKey } from '../../shared/annotationPath'

/** Strings longer than this are truncated until the reader asks for the rest. */
const LONG_STRING = 5000

/**
 * What the tree needs to render annotations: which locations of the value
 * on screen are annotated, and what to do when the reader presses an
 * annotate control. Absent when the tree renders without annotation support.
 */
export type AnnotationView = {
  /** Path keys (see `pathKey`) of the annotated locations in this value. */
  annotatedKeys: Set<string>
  /** Called with the path of the entry whose control was pressed. */
  onToggle: (path: JsonPath) => void
}

/**
 * Human-readable rendering of any JSON value: objects read as label/value
 * entries, arrays as numbered lists, nested groups get a quiet hairline
 * panel and fold behind a count summary.
 */
export function JsonView({ value, annotation }: { value: unknown; annotation?: AnnotationView }): ReactNode {
  return <div className="jv">{renderNode(value, [], annotation)}</div>
}

function renderNode(value: unknown, path: JsonPath, annotation?: AnnotationView): ReactNode {
  if (value === null) return <span className="jv-null">null</span>
  if (typeof value === 'string') return <StringValue text={value} />
  if (typeof value === 'number') return <span className="jv-number">{String(value)}</span>
  if (typeof value === 'boolean') return <span className="jv-boolean">{String(value)}</span>

  if (Array.isArray(value)) {
    if (value.length === 0) return <Empty text="Empty array" />
    return (
      <Group kind="array" count={value.length}>
        <ul className="jv-list">
          {value.map((item, index) => {
            const itemPath: JsonPath = [...path, index]
            const annotated = annotation?.annotatedKeys.has(pathKey(itemPath)) ?? false
            return (
              <li key={index} className={annotated ? 'jv-annotated' : undefined}>
                {annotation && <AnnotateControl annotated={annotated} onToggle={() => annotation.onToggle(itemPath)} />}
                {renderNode(item, itemPath, annotation)}
              </li>
            )
          })}
        </ul>
      </Group>
    )
  }

  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length === 0) return <Empty text="Empty object" />
  return (
    <Group kind="object" count={entries.length}>
      <div className="jv-fields">
        {entries.map(([key, entryValue]) => {
          const fieldPath: JsonPath = [...path, key]
          const annotated = annotation?.annotatedKeys.has(pathKey(fieldPath)) ?? false
          return (
            <div className={`jv-field${annotated ? ' jv-annotated' : ''}`} key={key}>
              <div className="jv-key-row">
                <div className="jv-key">{key === '' ? '""' : key}</div>
                {annotation && (
                  <AnnotateControl annotated={annotated} onToggle={() => annotation.onToggle(fieldPath)} />
                )}
              </div>
              <div className="jv-value">{renderNode(entryValue, fieldPath, annotation)}</div>
            </div>
          )
        })}
      </div>
    </Group>
  )
}

/**
 * The per-entry annotate control: hidden until the entry is hovered, then
 * an "Annotate" action — or a persistent ✕ on an already annotated entry.
 */
function AnnotateControl({ annotated, onToggle }: { annotated: boolean; onToggle: () => void }): ReactNode {
  return (
    <button
      type="button"
      className={`annotate-control${annotated ? ' remove' : ''}`}
      title={annotated ? 'Remove annotation' : 'Annotate this value'}
      aria-label={annotated ? 'Remove annotation' : 'Annotate this value'}
      onClick={onToggle}
    >
      {annotated ? '✕' : 'Annotate'}
    </button>
  )
}

/**
 * A foldable object or array: a header button showing the count, then the
 * body only while expanded. Unusually large groups start collapsed so an
 * item opens as a readable overview instead of a wall.
 */
function Group({ kind, count, children }: { kind: 'array' | 'object'; count: number; children: ReactNode }): ReactNode {
  const [open, setOpen] = useState(() => !shouldCollapse(count))
  const summary = `${count.toLocaleString()} ${kind === 'array' ? (count === 1 ? 'item' : 'items') : count === 1 ? 'entry' : 'entries'}`
  return (
    <div className="jv-group">
      <button type="button" className="jv-summary" aria-expanded={open} onClick={() => setOpen((prev) => !prev)}>
        {summary}
      </button>
      {open && children}
    </div>
  )
}

function StringValue({ text }: { text: string }): ReactNode {
  const [expanded, setExpanded] = useState(false)
  const isLong = text.length > LONG_STRING
  const shown = isLong && !expanded ? `${text.slice(0, LONG_STRING)}…` : text
  return (
    <>
      <span className="jv-string">{shown}</span>
      {isLong && !expanded && (
        <button className="jv-more" onClick={() => setExpanded(true)}>
          Show all {text.length.toLocaleString()} characters
        </button>
      )}
    </>
  )
}

function Empty({ text }: { text: string }): ReactNode {
  return <span className="jv-empty">{text}</span>
}
