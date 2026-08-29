import { describe, expect, it } from 'vitest'
import { parseItemJump } from './itemJump'

describe('parseItemJump', () => {
  it('jumps to the 0-based index of a plain 1-based item number', () => {
    expect(parseItemJump('1', 120000)).toEqual({ kind: 'jump', index: 0 })
    expect(parseItemJump('5000', 120000)).toEqual({ kind: 'jump', index: 4999 })
    expect(parseItemJump('120000', 120000)).toEqual({ kind: 'jump', index: 119999 })
  })

  it('ignores surrounding whitespace and thousands separators', () => {
    expect(parseItemJump(' 12 ', 100)).toEqual({ kind: 'jump', index: 11 })
    expect(parseItemJump('3,456', 10000)).toEqual({ kind: 'jump', index: 3455 })
    expect(parseItemJump('1,000,000', 1000000)).toEqual({ kind: 'jump', index: 999999 })
  })

  it('treats empty input as a no-op, not an error', () => {
    expect(parseItemJump('', 100)).toEqual({ kind: 'noop' })
    expect(parseItemJump('   ', 100)).toEqual({ kind: 'noop' })
    expect(parseItemJump(',', 100)).toEqual({ kind: 'noop' })
  })

  it('rejects non-numeric text, decimals and signs', () => {
    expect(parseItemJump('abc', 100)).toEqual({ kind: 'invalid' })
    expect(parseItemJump('12a', 100)).toEqual({ kind: 'invalid' })
    expect(parseItemJump('3.5', 100)).toEqual({ kind: 'invalid' })
    expect(parseItemJump('-5', 100)).toEqual({ kind: 'invalid' })
    expect(parseItemJump('+5', 100)).toEqual({ kind: 'invalid' })
    expect(parseItemJump('1e3', 100)).toEqual({ kind: 'invalid' })
  })

  it('rejects zero and out-of-range numbers', () => {
    expect(parseItemJump('0', 100)).toEqual({ kind: 'invalid' })
    expect(parseItemJump('101', 100)).toEqual({ kind: 'invalid' })
    expect(parseItemJump('18446744073709551617', 100)).toEqual({ kind: 'invalid' })
  })

  it('rejects anything when the array is empty', () => {
    expect(parseItemJump('1', 0)).toEqual({ kind: 'invalid' })
  })
})
