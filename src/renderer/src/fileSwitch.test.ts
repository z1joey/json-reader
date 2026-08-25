import { describe, expect, it } from 'vitest'
import { decideFileSwitch } from './fileSwitch'

const threeFiles = { fileCount: 3, activeIndex: 1 }

describe('decideFileSwitch', () => {
  it('opens the next and previous file in a multi-file folder', () => {
    expect(decideFileSwitch('next', { ...threeFiles })).toEqual({ kind: 'open', index: 2 })
    expect(decideFileSwitch('previous', { ...threeFiles })).toEqual({ kind: 'open', index: 0 })
  })

  it('stops at the first and last file instead of wrapping', () => {
    const first = { fileCount: 3, activeIndex: 0 }
    const last = { fileCount: 3, activeIndex: 2 }
    expect(decideFileSwitch('previous', first)).toEqual({ kind: 'none' })
    expect(decideFileSwitch('next', last)).toEqual({ kind: 'none' })
  })

  it('does nothing when the folder has fewer than two files', () => {
    expect(decideFileSwitch('next', { fileCount: 1, activeIndex: 0 })).toEqual({ kind: 'none' })
    expect(decideFileSwitch('previous', { fileCount: 1, activeIndex: 0 })).toEqual({ kind: 'none' })
    expect(decideFileSwitch('next', { fileCount: 0, activeIndex: 0 })).toEqual({ kind: 'none' })
  })

  it('does nothing without a folder', () => {
    expect(decideFileSwitch('next', null)).toEqual({ kind: 'none' })
    expect(decideFileSwitch('previous', null)).toEqual({ kind: 'none' })
  })
})
