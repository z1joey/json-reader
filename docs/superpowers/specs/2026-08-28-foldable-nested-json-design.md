# Foldable nested JSON view

Date: 2026-08-28
Status: Approved

## Problem

`JsonView` renders every nested object/array as a full hairline panel
(16px/18px padding) and every array level adds a 34px indent, so each nesting
level costs 40–70px of width before text renders. Deeply nested items (e.g.
entry → partOfSpeech → senses → sense) wrap their prose in a fraction of the
window, and nothing is collapsible, so every level renders at once.

## Decision

Keep the document style (approach A over a DevTools-style tree or a hybrid):
every non-empty array and object becomes a foldable group, large groups start
collapsed, and nested chrome is flattened. Scope chosen by the user: foldable
arrays **and** objects; groups larger than 20 items/entries start collapsed.

## Group header

- Every non-empty array/object renders a `<button class="jv-summary">` above
  its body: a disclosure arrow plus a count summary ("12 items" / "3
  entries", singular-aware, localized digits). The parent field's key label
  provides the name, so the header stays count-only.
- `aria-expanded` reflects state; native button semantics give Enter/Space
  and focus for free.
- Collapsed groups unmount their children — a render win on large arrays.
- Empty arrays/objects keep today's italic "Empty array/object" text and get
  no header.
- The root value gets a group too, so a value view whose root is a huge
  array starts as one collapsible line.

## Default-collapse policy

`shouldCollapse(count)` in `src/renderer/src/collapse.ts` returns
`count > 20` (threshold exported as `LARGE_GROUP`). Count-only — depth is not
a policy input. Unit-tested boundaries: 0, 1, 20 expand; 21 and up collapse.

## Flattened deep chrome (CSS only)

- Groups keep the hairline panel at the first level only; any `.jv-group`
  inside another `.jv-group` drops the box for a 2px left rule, no
  background, reduced padding — via a plain `.jv-group .jv-group` rule, no
  depth prop.
- `.jv-list > li` indent reduced 34px → 22px; minor gap tuning.

## Fold-state isolation

`App.tsx` keys `ItemBody` by `fileName:index` (array view) and the value
view's `JsonView` by `fileName`, so every item opens with a fresh tree. This
also fixes a pre-existing leak where a long string's expanded state carried
into the next item.

## Files

- `src/renderer/src/collapse.ts` + `collapse.test.ts` — policy.
- `src/renderer/src/JsonView.tsx` — `Group` component (header + conditional
  body), arrays and objects routed through it.
- `src/renderer/src/index.css` — `.jv-summary` styles, flatten rules.
- `src/renderer/src/App.tsx` — identity keys.

## Out of scope

DevTools-style tree mode, expand-all/collapse-all controls, remembering fold
state across items, changing the key-above-value field layout.
