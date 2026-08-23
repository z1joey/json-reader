import { useEffect, useRef, useState } from 'react'
import type { SearchHit } from '../../shared/types'
import { jsonReader } from './ipc'

const DEBOUNCE_MS = 200

type Props = {
  inputRef: React.RefObject<HTMLInputElement | null>
  onSelect: (hit: SearchHit) => void
}

function HighlightedSnippet({ hit }: { hit: SearchHit }): React.ReactElement {
  const { snippet, matchStart, matchLength } = hit
  if (matchLength <= 0 || matchStart < 0 || matchStart + matchLength > snippet.length) {
    return <>{snippet}</>
  }
  return (
    <>
      {snippet.slice(0, matchStart)}
      <mark>{snippet.slice(matchStart, matchStart + matchLength)}</mark>
      {snippet.slice(matchStart + matchLength)}
    </>
  )
}

export default function SearchBar({ inputRef, onSelect }: Props): React.ReactElement {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [moreAvailable, setMoreAvailable] = useState(false)
  const [searching, setSearching] = useState(false)
  const [noMatches, setNoMatches] = useState(false)
  const [active, setActive] = useState(-1)
  const [open, setOpen] = useState(false)
  const seqRef = useRef(0)
  const wrapRef = useRef<HTMLDivElement>(null)

  const reset = (): void => {
    setQuery('')
    inputRef.current?.blur()
  }

  // Debounced search; stale replies are dropped by sequence number.
  useEffect(() => {
    const trimmed = query.trim()
    if (!trimmed) {
      seqRef.current++
      setHits([])
      setMoreAvailable(false)
      setSearching(false)
      setNoMatches(false)
      setActive(-1)
      setOpen(false)
      return
    }
    setSearching(true)
    setOpen(true)
    const id = ++seqRef.current
    const timer = setTimeout(async () => {
      const result = await jsonReader.search(trimmed)
      if (seqRef.current !== id) return
      setSearching(false)
      if (result.status === 'ok') {
        setHits(result.hits)
        setMoreAvailable(result.moreAvailable)
        setNoMatches(result.hits.length === 0)
        setActive(result.hits.length > 0 ? 0 : -1)
      }
      // 'canceled' and 'error' keep the previous result list on screen.
    }, DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query])

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent): void => {
      if (!wrapRef.current?.contains(event.target as Node)) reset()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const pick = (hit: SearchHit | undefined): void => {
    if (!hit) return
    onSelect(hit)
    setOpen(false)
    setActive(-1)
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!open && hits.length > 0) {
        setOpen(true)
        return
      }
      if (hits.length === 0) return
      const delta = event.key === 'ArrowDown' ? 1 : -1
      setActive((prev) => Math.min(hits.length - 1, Math.max(0, prev + delta)))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      pick(hits[active] ?? hits[0])
    } else if (event.key === 'Escape') {
      event.preventDefault()
      reset()
    }
  }

  return (
    <div className="header-search" ref={wrapRef}>
      <input
        ref={inputRef}
        className="search-input"
        type="text"
        placeholder="Search items…"
        aria-label="Search items"
        role="combobox"
        aria-expanded={open}
        aria-controls="search-results"
        aria-activedescendant={
          open && active >= 0 && hits[active] ? `search-result-${hits[active].fileIndex}-${hits[active].index}` : undefined
        }
        autoComplete="off"
        spellCheck={false}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onFocus={() => hits.length > 0 && setOpen(true)}
        onKeyDown={onKeyDown}
      />
      {searching && <span className="spinner search-spin" aria-hidden="true" />}
      {open && (
        <div className="search-pop">
          {noMatches ? (
            <p className="search-empty">No matches.</p>
          ) : (
            <ul className="search-list" id="search-results" role="listbox" aria-label="Search results">
              {hits.map((hit, i) => (
                <li
                  key={`${hit.fileIndex}-${hit.index}`}
                  id={`search-result-${hit.fileIndex}-${hit.index}`}
                  role="option"
                  aria-selected={i === active}
                  className={`search-hit${hit.tier === 1 ? ' exact' : ''}${i === active ? ' active' : ''}`}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => pick(hit)}
                >
                  <span className="search-file" title={hit.fileName}>
                    {hit.fileName}
                  </span>
                  <span className="search-main">
                    {hit.field && <span className="search-field">{hit.field}</span>}
                    <span className="search-snippet">
                      <HighlightedSnippet hit={hit} />
                    </span>
                  </span>
                  <span className="search-index">#{(hit.index + 1).toLocaleString()}</span>
                </li>
              ))}
              {moreAvailable && <li className="search-more">More matches found — refine your search.</li>}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
