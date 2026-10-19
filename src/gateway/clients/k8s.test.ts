import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('@/shared/utils', () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

import { createUserFetch } from './k8s'

type Seen = { port: number; method: string; auth: string | undefined; body: string }

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => resolve(body))
  })

describe('createUserFetch', () => {
  let server: Server
  let baseUrl: string
  const seen: Seen[] = []

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      seen.push({
        port: req.socket.remotePort ?? 0,
        method: req.method ?? '',
        auth: req.headers.authorization,
        body: await readBody(req),
      })
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: true }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })

  it('reuses keep-alive connections across sequential requests', async () => {
    seen.length = 0
    const userFetch = createUserFetch()

    for (let i = 0; i < 10; i++) {
      const res = await userFetch(`${baseUrl}/version`)
      expect(res.ok).toBe(true)
      expect(await res.json()).toEqual({ ok: true })
    }

    expect(seen).toHaveLength(10)
    // undici's pool opens a second connection when the next request is
    // dispatched before the first socket is marked free, then alternates
    // between the two. Without pooling this would be 10.
    expect(new Set(seen.map((s) => s.port)).size).toBeLessThanOrEqual(2)
  })

  it('forwards headers, method and body unchanged', async () => {
    seen.length = 0
    const userFetch = createUserFetch()

    const res = await userFetch(`${baseUrl}/users/u1`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: JSON.stringify({ a: 1 }),
    })

    expect(res.status).toBe(200)
    expect(seen).toEqual([
      expect.objectContaining({ method: 'PATCH', auth: 'Bearer t', body: '{"a":1}' }),
    ])
  })
})
