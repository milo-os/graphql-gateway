import { describe, expect, it } from 'vitest'
import { getRequestContext, requestIdFromHeaders, runWithRequestContext } from './request-context'

describe('runWithRequestContext', () => {
  it('makes the context visible to async continuations started inside it', async () => {
    const seen = await runWithRequestContext({ requestId: 'req-1' }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1))
      return getRequestContext()?.requestId
    })
    expect(seen).toBe('req-1')
  })

  it('is undefined outside of a request', () => {
    expect(getRequestContext()).toBeUndefined()
  })

  it('keeps concurrent requests apart', async () => {
    const [a, b] = await Promise.all([
      runWithRequestContext({ requestId: 'a' }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 2))
        return getRequestContext()?.requestId
      }),
      runWithRequestContext({ requestId: 'b' }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 1))
        return getRequestContext()?.requestId
      }),
    ])
    expect([a, b]).toEqual(['a', 'b'])
  })
})

describe('requestIdFromHeaders', () => {
  it('returns the incoming x-request-id when present', () => {
    expect(requestIdFromHeaders({ 'x-request-id': 'portal-123' })).toBe('portal-123')
  })

  it('generates a UUID when the header is absent or empty', () => {
    const generated = requestIdFromHeaders({ 'x-request-id': '' })
    expect(generated).toMatch(/^[0-9a-f-]{36}$/)
    expect(requestIdFromHeaders({})).not.toBe(generated)
  })
})
