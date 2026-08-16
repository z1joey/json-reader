import { useState, type ReactNode } from 'react'

/** Strings longer than this are truncated until the reader asks for the rest. */
const LONG_STRING = 5000

function isGroup(value: unknown): boolean {
  return value !== null && typeof value === 'object'
}

/**
 * Human-readable rendering of any JSON value: objects read as label/value
 * entries, arrays as numbered lists, nested groups get a quiet hairline
 * panel and one level of visual nesting per depth.
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
      <ul className="jv-list">
        {value.map((item, index) => (
          <li key={index}>{isGroup(item) ? <div className="jv-group">{renderNode(item)}</div> : renderNode(item)}</li>
        ))}
      </ul>
    )
  }

  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length === 0) return <Empty text="Empty object" />
  return (
    <div className="jv-fields">
      {entries.map(([key, entryValue]) => (
        <div className="jv-field" key={key}>
          <div className="jv-key">{key === '' ? '""' : key}</div>
          <div className="jv-value">
            {isGroup(entryValue) ? <div className="jv-group">{renderNode(entryValue)}</div> : renderNode(entryValue)}
          </div>
        </div>
      ))}
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
