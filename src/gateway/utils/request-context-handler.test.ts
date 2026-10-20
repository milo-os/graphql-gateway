import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { getRequestContext } from '@/shared/request-context'
import { withRequestContext } from './request-context-handler'

const fakeReq = (headers: Record<string, string>) =>
  Object.assign(new EventEmitter(), {
    headers,
    url: '/graphql',
    method: 'POST',
  }) as unknown as IncomingMessage

const fakeRes = () => {
  const set: Record<string, string> = {}
  return {
    res: { setHeader: vi.fn((k: string, v: string) => (set[k] = v)) } as unknown as ServerResponse,
    set,
  }
}

describe('withRequestContext', () => {
  it('makes the ids visible to the handler after an await and rewrites the inbound header', async () => {
    let seen: ReturnType<typeof getRequestContext>
    const handler = withRequestContext(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1))
      seen = getRequestContext()
    })
    const req = fakeReq({ 'x-request-id': 'portal-1' })
    const { res, set } = fakeRes()

    await handler(req, res)

    expect(seen).toEqual({
      requestId: 'portal-1',
      auditId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    })
    expect(req.headers['x-request-id']).toBe('portal-1')
    expect(set['x-request-id']).toBe('portal-1')
  })

  it('replaces an untrusted inbound id and echoes the generated one', async () => {
    const handler = withRequestContext(async () => {})
    const req = fakeReq({ 'x-request-id': 'not valid!' })
    const { res, set } = fakeRes()

    await handler(req, res)

    expect(req.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/)
    expect(set['x-request-id']).toBe(req.headers['x-request-id'])
  })

  it('never reuses the inbound id as the audit id', async () => {
    let seen: ReturnType<typeof getRequestContext>
    const handler = withRequestContext(async () => {
      seen = getRequestContext()
    })

    await handler(fakeReq({ 'x-request-id': 'portal-2' }), fakeRes().res)

    expect(seen?.auditId).not.toBe('portal-2')
  })
})
