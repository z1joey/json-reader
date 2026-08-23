import { describe, expect, it } from 'vitest'
import type { SearchHit } from '../../shared/types'
import { decideSearchSelect, type SelectFolder } from './searchSelect'

function hit(fileIndex: number, index: number): SearchHit {
  return {
    fileIndex,
    index,
    tier: 1,
    field: null,
    snippet: 'apple',
    matchStart: 0,
    matchLength: 5,
    fileName: 'a.json'
  }
}

const folder: SelectFolder = { files: ['a.json', 'b.json'], activeIndex: 0 }

describe('decideSearchSelect', () => {
  it('opens another file and jumps to the hit item', () => {
    expect(decideSearchSelect(hit(1, 3), folder, false, true)).toEqual({ kind: 'open', index: 1, itemIndex: 3 })
  })

  it('jumps directly inside the active array file', () => {
    expect(decideSearchSelect(hit(0, 4), folder, false, true)).toEqual({ kind: 'jump', itemIndex: 4 })
  })

  it('queues a hit for the file that is still loading instead of dropping it', () => {
    // The active file is mid-open (view is 'loading'), so the plain jump
    // branch would be a no-op; the open machinery must take the request.
    expect(decideSearchSelect(hit(0, 2), folder, true, false)).toEqual({ kind: 'open', index: 0, itemIndex: 2 })
  })

  it('ignores hits whose file index is outside the folder list', () => {
    expect(decideSearchSelect(hit(5, 0), folder, false, false)).toEqual({ kind: 'none' })
  })

  it('drops a hit without a folder unless the current view is an array', () => {
    expect(decideSearchSelect(hit(0, 1), null, false, false)).toEqual({ kind: 'none' })
    expect(decideSearchSelect(hit(0, 1), null, false, true)).toEqual({ kind: 'jump', itemIndex: 1 })
  })
})
