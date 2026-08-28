import { useEffect, useRef, useState } from 'react'
import { parseItemJump } from './itemJump'

type Props = {
  /** 0-based index of the current item. */
  index: number
  /** Total number of items; the input must stay within `1..count`. */
  count: number
  /** Called with a validated 0-based index when a jump commits. */
  onJump: (index: number) => void
}

/**
 * The footer position control: the current item number as an editable
 * input, followed by the static total. Typing a valid number and pressing
 * Enter (or leaving the field) jumps to that item; anything invalid flashes
 * an error and reverts to the current number.
 */
export default function ItemPosition({ index, count, onJump }: Props): React.ReactElement {
  const [draft, setDraft] = useState(() => String(index + 1))
  const [error, setError] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  // Escape reverts and blurs; the blur must not then re-commit the reverted value.
  const skipNextBlurRef = useRef(false)

  // Any index change from outside (arrows, buttons, search, file switch)
  // wins over whatever is in the field.
  useEffect(() => {
    setDraft(String(index + 1))
    setError(false)
  }, [index])

  const revert = (): void => {
    setDraft(String(index + 1))
    setError(false)
  }

  const commit = (): void => {
    const decision = parseItemJump(draft, count)
    if (decision.kind === 'jump') {
      // Blur after Enter re-commits the value that is already shown.
      if (decision.index !== index) onJump(decision.index)
      setDraft(String(decision.index + 1))
      setError(false)
    } else if (decision.kind === 'invalid') {
      setError(true)
      setDraft(String(index + 1))
    } else {
      revert()
    }
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault()
      commit()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      skipNextBlurRef.current = true
      revert()
      inputRef.current?.blur()
    }
  }

  const onBlur = (): void => {
    if (skipNextBlurRef.current) {
      skipNextBlurRef.current = false
      return
    }
    commit()
  }

  return (
    <span className="position">
      <input
        ref={inputRef}
        className={`position-input${error ? ' error' : ''}`}
        style={{ width: `${Math.max(3, String(count).length, draft.length)}ch` }}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        spellCheck={false}
        aria-label="Go to item"
        aria-invalid={error || undefined}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value)
          setError(false)
        }}
        onFocus={(event) => event.target.select()}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
      />{' '}
      / {count.toLocaleString()}
    </span>
  )
}
