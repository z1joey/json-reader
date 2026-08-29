import { useCallback, useEffect, useRef, useState } from 'react'
import type { RootInfo, SearchHit } from '../../shared/types'
import { jsonReader } from './ipc'
import FilePanel from './FilePanel'
import ItemPosition from './ItemPosition'
import { JsonView } from './JsonView'
import SearchBar from './SearchBar'
import { decideFileSwitch, latestRequestedIndex } from './fileSwitch'
import { decideSearchSelect } from './searchSelect'

type ItemState = { loading: true } | { value: unknown } | { error: string }

type State =
  | { view: 'empty' }
  | { view: 'loading' }
  | { view: 'array'; fileName: string; count: number; index: number; item: ItemState }
  | { view: 'value'; fileName: string; value: unknown }
  | { view: 'error'; fileName: string; message: string }

type FolderState = { name: string; files: string[]; activeIndex: number }

type PendingFolderRequest = { index: number; itemIndex?: number }

const isMac = navigator.platform.startsWith('Mac')

function fileNameOf(state: State): string | null {
  if (state.view === 'array' || state.view === 'value' || state.view === 'error') return state.fileName
  return null
}

export default function App(): React.ReactElement {
  const [state, setState] = useState<State>({ view: 'empty' })
  const [folder, setFolder] = useState<FolderState | null>(null)
  const [version, setVersion] = useState('')
  useEffect(() => {
    void jsonReader.getVersion().then(setVersion)
  }, [])
  const stateRef = useRef(state)
  stateRef.current = state
  const searchInputRef = useRef<HTMLInputElement>(null)
  // A file load is in flight; refs (not state) so rapid clicks read them
  // synchronously instead of waiting for a re-render.
  const loadingRef = useRef(false)
  const loadingFolderIndexRef = useRef<number | null>(null)
  // The latest panel click or search selection made while a load was in flight
  // (last write wins).
  const pendingFolderIndexRef = useRef<PendingFolderRequest | null>(null)

  const applyOpenedFile = useCallback((fileName: string, root: RootInfo): void => {
    if (root.type === 'array') {
      setState({
        view: 'array',
        fileName,
        count: root.count,
        index: 0,
        item: { loading: true }
      })
    } else {
      setState({ view: 'value', fileName, value: root.value })
    }
  }, [])

  const loadFolderFile = useCallback(
    async (index: number, itemIndex?: number) => {
      loadingRef.current = true
      loadingFolderIndexRef.current = index
      setFolder((prev) => (prev ? { ...prev, activeIndex: index } : prev))
      setState({ view: 'loading' })
      const result = await jsonReader.openFile(index)
      if (result.status === 'ok') {
        if (itemIndex !== undefined && result.root.type === 'array' && itemIndex >= 0 && itemIndex < result.root.count) {
          setState({
            view: 'array',
            fileName: result.fileName,
            count: result.root.count,
            index: itemIndex,
            item: { loading: true }
          })
        } else {
          applyOpenedFile(result.fileName, result.root)
        }
      } else {
        setState({ view: 'error', fileName: result.fileName, message: result.error })
      }
      // Last write wins: if another panel click arrived while this file was
      // opening, load it now instead of dropping it.
      loadingFolderIndexRef.current = null
      loadingRef.current = false
      const pending = pendingFolderIndexRef.current
      pendingFolderIndexRef.current = null
      if (pending !== null) void loadFolderFile(pending.index, pending.itemIndex)
    },
    [applyOpenedFile]
  )

  const openFromFolder = useCallback(
    (index: number, itemIndex?: number) => {
      if (loadingRef.current) {
        // A load is in flight: remember the latest request. Clicking the file
        // that is already loading is a no-op unless a specific item was asked.
        if (loadingFolderIndexRef.current !== index || itemIndex !== undefined) {
          pendingFolderIndexRef.current = { index, itemIndex }
        }
        return
      }
      void loadFolderFile(index, itemIndex)
    },
    [loadFolderFile]
  )

  const handleSearchSelect = useCallback(
    (hit: SearchHit) => {
      const decision = decideSearchSelect(hit, folder, loadingRef.current, stateRef.current.view === 'array')
      if (decision.kind === 'open') {
        openFromFolder(decision.index, decision.itemIndex)
      } else if (decision.kind === 'jump') {
        // A hit for the item already shown must not set loading: the getItem
        // effect keys on the index, so 'loading' would never clear.
        setState((prev) =>
          prev.view === 'array' && decision.itemIndex !== prev.index
            ? { ...prev, index: decision.itemIndex, item: { loading: true } }
            : prev
        )
      }
    },
    [folder, openFromFolder]
  )

  const pickFolder = useCallback(async () => {
    if (loadingRef.current) return
    const before = stateRef.current
    loadingRef.current = true
    setState({ view: 'loading' })
    const result = await jsonReader.openFolder()
    // A dialog open replaces the folder, so a queued panel click can no
    // longer be honored.
    pendingFolderIndexRef.current = null
    if (result.status === 'canceled') {
      loadingRef.current = false
      setState(before)
      return
    }
    if (result.status === 'error') {
      setFolder(null)
      setState({ view: 'error', fileName: result.fileName, message: result.error })
      loadingRef.current = false
      return
    }
    if (result.status === 'folder') {
      setFolder({ name: result.folderName, files: result.files, activeIndex: 0 })
      void loadFolderFile(0)
      return
    }
    setFolder(null)
    applyOpenedFile(result.fileName, result.root)
    loadingRef.current = false
  }, [applyOpenedFile, loadFolderFile])

  useEffect(() => jsonReader.onOpenFolderRequested(() => void pickFolder()), [pickFolder])

  // The whole app is keyboard-driven: no element needs focus for these to work.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'o') {
        event.preventDefault()
        void pickFolder()
        return
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
        if (stateRef.current.view === 'array' || folder) {
          event.preventDefault()
          searchInputRef.current?.focus()
        }
        return
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return
      // Arrow keys typed inside the search field belong to it, not the pager.
      const tag = (event.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      const previous = event.key === 'ArrowLeft' || event.key === 'PageUp'
      const next = event.key === 'ArrowRight' || event.key === 'PageDown'
      const filePrevious = event.key === 'ArrowUp'
      const fileNext = event.key === 'ArrowDown'
      if (!previous && !next && !filePrevious && !fileNext) return
      // ↑/↓ switch between the files of the opened folder; they never page
      // array items and do nothing unless a multi-file folder is open.
      if (filePrevious || fileNext) {
        // The queued request outranks the in-flight load, which outranks the
        // last finished file — otherwise rapid presses collapse into one step.
        const activeIndex = latestRequestedIndex(
          pendingFolderIndexRef.current?.index ?? null,
          loadingFolderIndexRef.current,
          folder?.activeIndex
        )
        const decision = decideFileSwitch(
          fileNext ? 'next' : 'previous',
          folder ? { fileCount: folder.files.length, activeIndex } : null
        )
        if (decision.kind !== 'open') return
        event.preventDefault()
        openFromFolder(decision.index)
        return
      }
      const current = stateRef.current
      if (current.view !== 'array') return
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
  }, [folder, openFromFolder, pickFolder])

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
  // A jump to the position already shown must not restart the item load:
  // the getItem effect keys on the index, so 'loading' would never clear.
  const jumpTo = (index: number): void =>
    setState((prev) =>
      prev.view === 'array' && index >= 0 && index < prev.count && index !== prev.index
        ? { ...prev, index, item: { loading: true } }
        : prev
    )

  return (
    <div className="app">
      <header className="header">
        {(folder || (state.view === 'array' && state.count > 0)) && (
          <SearchBar
            key={folder ? `${folder.name}:${folder.files.join(',')}` : state.view === 'array' ? state.fileName : ''}
            inputRef={searchInputRef}
            onSelect={handleSearchSelect}
          />
        )}
        {version && <span className="app-version">v{version}</span>}
      </header>

      <div className="body">
        {folder && (
          <FilePanel
            name={folder.name}
            files={folder.files}
            activeIndex={folder.activeIndex}
            onSelect={openFromFolder}
          />
        )}

        <main className="content">
          {state.view === 'empty' && <EmptyState onOpenFolder={() => void pickFolder()} />}
          {state.view === 'loading' && (
            <div className="center-state">
              <div className="spinner" />
              <p className="state-text">Loading…</p>
            </div>
          )}
          {state.view === 'error' && (
            <ErrorState message={state.message} onOpenFolder={folder ? null : () => void pickFolder()} />
          )}
          {state.view === 'value' && (
            <div className="doc">
              {/* Keyed by origin + name so each file opens a fresh tree and
                  fold/expand state never leaks from a same-named file in
                  another folder (or a single-file pick). */}
              <JsonView key={`${folder?.name ?? 'file'}:${state.fileName}`} value={state.value} />
            </div>
          )}
          {state.view === 'array' &&
            (state.count === 0 ? (
              <div className="center-state">
                <p className="state-text">This array is empty.</p>
              </div>
            ) : (
              <div className="doc">
                {/* Keyed per origin+file+item for the same reason as the value view. */}
                <ItemBody key={`${folder?.name ?? 'file'}:${state.fileName}:${state.index}`} item={state.item} />
              </div>
            ))}
        </main>
      </div>

      {state.view === 'array' && state.count > 0 && (
        <footer className="footer">
          <button className="button" onClick={goPrevious} disabled={state.index === 0}>
            ← Previous
          </button>
          <ItemPosition index={state.index} count={state.count} onJump={jumpTo} />
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
    return <ErrorState message={item.error} onOpenFolder={null} />
  }
  return <JsonView value={item.value} />
}

function EmptyState({ onOpenFolder }: { onOpenFolder: () => void }): React.ReactElement {
  return (
    <div className="center-state">
      <div className="glyph">{'{ }'}</div>
      <p className="state-text">Open a folder to start reading JSON files</p>
      <button className="button" onClick={onOpenFolder}>
        Open Folder
      </button>
      <p className="hint">
        or press <kbd>{isMac ? '⌘O' : 'Ctrl+O'}</kbd>
      </p>
    </div>
  )
}

function ErrorState({ message, onOpenFolder }: { message: string; onOpenFolder: (() => void) | null }): React.ReactElement {
  return (
    <div className="center-state">
      <h2 className="error-title">Unable to read JSON</h2>
      <p className="error-message">{message}</p>
      {onOpenFolder && (
        <button className="button" onClick={onOpenFolder}>
          Open Folder
        </button>
      )}
    </div>
  )
}
