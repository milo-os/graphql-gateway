import { describe, expect, it } from 'vitest'
import { getRequestContext, requestIdFromHeaders, runWithRequestContext } from './request-context'

describe('runWithRequestContext', () => {
  it('makes the context visible to async continuations started inside it', async () => {
    const seen = await runWithRequestContext({ requestId: 'req-1', auditId: 'a-1' }, async () => {
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
      runWithRequestContext({ requestId: 'a', auditId: 'a-a' }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 2))
        return getRequestContext()?.requestId
      }),
      runWithRequestContext({ requestId: 'b', auditId: 'a-b' }, async () => {
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

  it('replaces an id that is too long or carries unexpected characters', () => {
    const uuid = /^[0-9a-f-]{36}$/
    expect(requestIdFromHeaders({ 'x-request-id': 'a'.repeat(129) })).toMatch(uuid)
    expect(requestIdFromHeaders({ 'x-request-id': 'id with spaces' })).toMatch(uuid)
    expect(requestIdFromHeaders({ 'x-request-id': 'x\r\ninjected: header' })).toMatch(uuid)
    expect(requestIdFromHeaders({ 'x-request-id': 'req_01.ABC-xyz' })).toBe('req_01.ABC-xyz')
  })

  it('generates a UUID when the header is absent or empty', () => {
    const generated = requestIdFromHeaders({ 'x-request-id': '' })
    expect(generated).toMatch(/^[0-9a-f-]{36}$/)
    expect(requestIdFromHeaders({})).not.toBe(generated)
  })
})
