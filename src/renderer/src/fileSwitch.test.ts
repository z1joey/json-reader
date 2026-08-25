import { describe, expect, it } from 'vitest'
import { decideFileSwitch, latestRequestedIndex } from './fileSwitch'

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

describe('latestRequestedIndex', () => {
  it('prefers the queued target over the in-flight load over the settled file', () => {
    expect(latestRequestedIndex(2, 0, 0)).toBe(2)
    expect(latestRequestedIndex(null, 1, 0)).toBe(1)
    expect(latestRequestedIndex(null, null, 4)).toBe(4)
    expect(latestRequestedIndex(null, null, undefined)).toBe(-1)
  })

  it('advances one file per press even while a load is in flight', () => {
    // Regression: every press used to re-read the in-flight load's frozen
    // target, so three rapid ↓ presses on a loading file landed one step
    // out instead of three.
    let pending: number | null = null
    const press = (): number => {
      const activeIndex = latestRequestedIndex(pending, 0, 0)
      const decision = decideFileSwitch('next', { fileCount: 5, activeIndex })
      if (decision.kind === 'open') pending = decision.index
      return activeIndex
    }
    expect(press()).toBe(0)
    expect(press()).toBe(1)
    expect(press()).toBe(2)
    expect(pending).toBe(3)
  })
})
