import { describe, expect, it } from 'vitest'
import { LARGE_GROUP, shouldCollapse } from './collapse'

describe('shouldCollapse', () => {
  it('leaves groups up to the threshold expanded', () => {
    expect(shouldCollapse(0)).toBe(false)
    expect(shouldCollapse(1)).toBe(false)
    expect(shouldCollapse(LARGE_GROUP)).toBe(false)
  })

  it('collapses groups larger than the threshold', () => {
    expect(shouldCollapse(LARGE_GROUP + 1)).toBe(true)
    expect(shouldCollapse(5000)).toBe(true)
  })
})
