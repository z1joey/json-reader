# Editable item-number jump in the footer

Date: 2026-08-28
Status: Approved

## Problem

The footer of the array view shows the current position as static text
(`5,000 / 120,000`) with Previous/Next buttons. In a large array, stepping to a
known position one item at a time is impractical. The user wants to type a
number and jump straight to that item.

## Decision

The current item number in the footer becomes an editable input. "Page" here
means the current item position (the app shows one array item at a time), not a
chunk of items. A plain text `<input>` with validation in a pure function
(matching the existing `fileSwitch.ts` / `searchSelect.ts` pattern) was chosen
over `<input type="number">` (browser quirks: silent emptying on bad input,
scroll-to-change, spinner noise, no grouped digits) and over global digit
capture (surprising, poor discoverability).

## UI

Footer layout: `← Previous   [ 5000 ] / 120,000   Next →`

- The input replaces the current-number half of the `.position` span; the
  ` / total` part stays static, localized with `toLocaleString()`.
- Input shows the current item as plain 1-based digits (no grouping
  separators). Mono font, right-aligned, sized to its content.
- `aria-label="Go to item"`, `aria-invalid` while the error state shows.
- Present whenever the footer is present (array view, count > 0). No item-count
  threshold: it is useful exactly when arrays are large, and a threshold only
  adds a special case.

## Interaction

- The input value syncs to the current item whenever the index changes from
  outside (arrow keys, Previous/Next, search jump, file switch).
- Focus selects all content, so typing replaces it.
- **Enter** commits: a valid number in `1..count` jumps to that item; anything
  else flashes an error style (red border, `aria-invalid`) and reverts to the
  current number. Invalid input never jumps. The error state clears when the
  user edits the value again or a later commit succeeds.
- **Escape** reverts to the current number and blurs.
- **Blur** commits, same rules as Enter.
- Arrow keys inside the input move the caret: the app's global key handler
  already ignores events originating from `INPUT` targets.

## Validation rules (`parseItemJump`)

`parseItemJump(raw: string, count: number)` returns one of:

- `{ kind: 'jump', index }` — trimmed input, with optional thousands
  separators (`,`) stripped, is all digits and a value in `1..count`;
  `index` is the 0-based item index (`n - 1`).
- `{ kind: 'noop' }` — empty or whitespace-only input (no error, no jump).
- `{ kind: 'invalid' }` — non-numeric text, decimals, signs, zero, values
  above `count`, or digits beyond `Number.MAX_SAFE_INTEGER`.

## App integration

`App.tsx` gains a `jumpTo(index)` callback mirroring `goPrevious`/`goNext`
(bounded, sets `item: { loading: true }`); the stale-item-fetch guard already
discards superseded `getItem` replies, so rapid jumps are safe.

## Components and files

- `src/renderer/src/itemJump.ts` — pure `parseItemJump`.
- `src/renderer/src/itemJump.test.ts` — unit tests for every rule above.
- `src/renderer/src/ItemPosition.tsx` — the footer position control: input +
  static total. Owns draft value, error flash, focus-select-all, key handling.
- `src/renderer/src/App.tsx` — render `ItemPosition` in the footer, `jumpTo`.
- `src/renderer/src/index.css` — styles for `.position-input` and its error
  state, matching the existing footer design tokens.

## Testing

- `itemJump.test.ts`: plain numbers, whitespace, comma grouping, empty input,
  non-numeric, decimals, negatives, zero, out-of-range both sides, huge digit
  strings, count boundary values.
- Existing suites must keep passing (`fileSwitch`, `searchSelect`, main
  process tests).

## Out of scope

- Multi-item pages / changed Previous-Next semantics.
- A page-size concept or UI to change it.
- Remembering the position across files.
