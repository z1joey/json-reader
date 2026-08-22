import { useCallback, useEffect, useRef, useState } from 'react'
import { jsonReader } from './ipc'
import { JsonView } from './JsonView'
import SearchBar from './SearchBar'

type ItemState = { loading: true } | { value: unknown } | { error: string }

type State =
  | { view: 'empty' }
  | { view: 'loading' }
  | { view: 'array'; fileName: string; count: number; index: number; item: ItemState }
  | { view: 'value'; fileName: string; value: unknown }
  | { view: 'error'; fileName: string; message: string }

const isMac = navigator.platform.startsWith('Mac')

function fileNameOf(state: State): string | null {
  if (state.view === 'array' || state.view === 'value' || state.view === 'error') return state.fileName
  return null
}

export default function App(): React.ReactElement {
  const [state, setState] = useState<State>({ view: 'empty' })
  const stateRef = useRef(state)
  stateRef.current = state
  const searchInputRef = useRef<HTMLInputElement>(null)

  const openFile = useCallback(async () => {
    if (stateRef.current.view === 'loading') return
    const before = stateRef.current
    setState({ view: 'loading' })
    const result = await jsonReader.open()
    if (result.status === 'canceled') {
      setState(before)
      return
    }
    if (result.status === 'error') {
      setState({ view: 'error', fileName: result.fileName, message: result.error })
      return
    }
    if (result.root.type === 'array') {
      setState({
        view: 'array',
        fileName: result.fileName,
        count: result.root.count,
        index: 0,
        item: { loading: true }
      })
    } else {
      setState({ view: 'value', fileName: result.fileName, value: result.root.value })
    }
  }, [])

  useEffect(() => jsonReader.onOpenRequested(() => void openFile()), [openFile])

  // The whole app is keyboard-driven: no element needs focus for these to work.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'o') {
        event.preventDefault()
        void openFile()
        return
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
        if (stateRef.current.view === 'array') {
          event.preventDefault()
          searchInputRef.current?.focus()
        }
        return
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return
      // Arrow keys typed inside the search field belong to it, not the pager.
      const tag = (event.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      const current = stateRef.current
      if (current.view !== 'array') return
      const previous = event.key === 'ArrowLeft' || event.key === 'ArrowUp' || event.key === 'PageUp'
      const next = event.key === 'ArrowRight' || event.key === 'ArrowDown' || event.key === 'PageDown'
      if (!previous && !next) return
      event.preventDefault()
      setState((prev) => {
        if (prev.view !== 'array') return prev
        if (previous && prev.index > 0) return { ...prev, index: prev.index - 1, item: { loading: true } }
        if (next && prev.index < prev.count - 1) return { ...prev, index: prev.index + 1, item: { loading: true } }
        return prev
      })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openFile])

  // Fetch the current item; a stale reply for an older index is discarded.
  const arrayIndex = state.view === 'array' ? state.index : -1
  useEffect(() => {
    if (arrayIndex < 0) return
    let alive = true
    jsonReader.getItem(arrayIndex).then((result) => {
      if (!alive) return
      setState((prev) => {
        if (prev.view !== 'array' || prev.index !== arrayIndex) return prev
        return { ...prev, item: result.status === 'ok' ? { value: result.value } : { error: result.error } }
      })
    })
    return () => {
      alive = false
    }
  }, [arrayIndex])

  const fileName = fileNameOf(state)
  useEffect(() => {
    document.title = fileName ? `${fileName} — JSON Reader` : 'JSON Reader'
  }, [fileName])

  const goPrevious = (): void =>
    setState((prev) =>
      prev.view === 'array' && prev.index > 0 ? { ...prev, index: prev.index - 1, item: { loading: true } } : prev
    )
  const goNext = (): void =>
    setState((prev) =>
      prev.view === 'array' && prev.index < prev.count - 1
        ? { ...prev, index: prev.index + 1, item: { loading: true } }
        : prev
    )

  return (
    <div className="app">
      <header className="header">
        <div className="header-title">
          <span className="app-name">JSON Reader</span>
          {fileName && (
            <span className="file-name" title={fileName}>
              {fileName}
            </span>
          )}
        </div>
        {state.view === 'array' && state.count > 0 && (
          <SearchBar
            key={state.fileName}
            inputRef={searchInputRef}
            onSelect={(index) =>
              setState((prev) => (prev.view === 'array' ? { ...prev, index, item: { loading: true } } : prev))
            }
          />
        )}
        <button className="button" onClick={() => void openFile()} disabled={state.view === 'loading'}>
          Open JSON
        </button>
      </header>

      <main className="content">
        {state.view === 'empty' && <EmptyState onOpen={() => void openFile()} />}
        {state.view === 'loading' && (
          <div className="center-state">
            <div className="spinner" />
            <p className="state-text">Loading…</p>
          </div>
        )}
        {state.view === 'error' && <ErrorState message={state.message} onOpen={() => void openFile()} />}
        {state.view === 'value' && (
          <div className="doc">
            <JsonView value={state.value} />
          </div>
        )}
        {state.view === 'array' &&
          (state.count === 0 ? (
            <div className="center-state">
              <p className="state-text">This array is empty.</p>
            </div>
          ) : (
            <div className="doc">
              <ItemBody item={state.item} />
            </div>
          ))}
      </main>

      {state.view === 'array' && state.count > 0 && (
        <footer className="footer">
          <button className="button" onClick={goPrevious} disabled={state.index === 0}>
            ← Previous
          </button>
          <span className="position" aria-label={`Item ${state.index + 1} of ${state.count}`}>
            {(state.index + 1).toLocaleString()} / {state.count.toLocaleString()}
          </span>
          <button className="button" onClick={goNext} disabled={state.index === state.count - 1}>
            Next →
          </button>
        </footer>
      )}
    </div>
  )
}

function ItemBody({ item }: { item: ItemState }): React.ReactElement {
  if ('loading' in item) {
    return (
      <div className="center-state">
        <div className="spinner" />
        <p className="state-text">Loading item…</p>
      </div>
    )
  }
  if ('error' in item) {
    return <ErrorState message={item.error} onOpen={null} />
  }
  return <JsonView value={item.value} />
}

function EmptyState({ onOpen }: { onOpen: () => void }): React.ReactElement {
  return (
    <div className="center-state">
      <div className="glyph">{'{ }'}</div>
      <p className="state-text">Open a JSON file to start reading</p>
      <button className="button" onClick={onOpen}>
        Open JSON
      </button>
      <p className="hint">
        or press <kbd>{isMac ? '⌘O' : 'Ctrl+O'}</kbd>
      </p>
    </div>
  )
}

function ErrorState({ message, onOpen }: { message: string; onOpen: (() => void) | null }): React.ReactElement {
  return (
    <div className="center-state">
      <h2 className="error-title">Unable to read JSON</h2>
      <p className="error-message">{message}</p>
      {onOpen && (
        <button className="button" onClick={onOpen}>
          Open JSON
        </button>
      )}
    </div>
  )
}
