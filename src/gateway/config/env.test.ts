import { describe, expect, it, vi } from 'vitest'

vi.mock('@/shared/utils', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { positiveMillis } from './env'

describe('positiveMillis', () => {
  it.each([
    [undefined, 10_000],
    ['', 10_000],
    ['abc', 10_000],
    ['0', 10_000],
    ['-5', 10_000],
    ['2500', 2500],
    ['2500.7', 2500],
  ])('%s -> %s', (raw, expected) => {
    expect(positiveMillis(raw, 10_000)).toBe(expected)
  })

  it('clamps values above what setTimeout can represent instead of letting them wrap to 1ms', () => {
    expect(positiveMillis('3600000000', 10_000)).toBe(2_147_483_647)
  })
})
