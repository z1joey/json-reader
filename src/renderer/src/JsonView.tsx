import { useState, type ReactNode } from 'react'
import { shouldCollapse } from './collapse'

/** Strings longer than this are truncated until the reader asks for the rest. */
const LONG_STRING = 5000

/**
 * Human-readable rendering of any JSON value: objects read as label/value
 * entries, arrays as numbered lists, nested groups get a quiet hairline
 * panel and fold behind a count summary.
 */
export function JsonView({ value }: { value: unknown }): ReactNode {
  return <div className="jv">{renderNode(value)}</div>
}

function renderNode(value: unknown): ReactNode {
  if (value === null) return <span className="jv-null">null</span>
  if (typeof value === 'string') return <StringValue text={value} />
  if (typeof value === 'number') return <span className="jv-number">{String(value)}</span>
  if (typeof value === 'boolean') return <span className="jv-boolean">{String(value)}</span>

  if (Array.isArray(value)) {
    if (value.length === 0) return <Empty text="Empty array" />
    return (
      <Group kind="array" count={value.length}>
        <ul className="jv-list">
          {value.map((item, index) => (
            <li key={index}>{renderNode(item)}</li>
          ))}
        </ul>
      </Group>
    )
  }

  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length === 0) return <Empty text="Empty object" />
  return (
    <Group kind="object" count={entries.length}>
      <div className="jv-fields">
        {entries.map(([key, entryValue]) => (
          <div className="jv-field" key={key}>
            <div className="jv-key">{key === '' ? '""' : key}</div>
            <div className="jv-value">{renderNode(entryValue)}</div>
          </div>
        ))}
      </div>
    </Group>
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
