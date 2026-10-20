import type { IncomingMessage, ServerResponse } from 'node:http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { runtime, auth, sent } = vi.hoisted(() => ({
  runtime: { isSupergraphReady: vi.fn(() => true), hasCompositionGivenUp: vi.fn(() => false) },
  auth: { isInitialized: vi.fn(() => true) },
  sent: [] as { status: number; body: unknown }[],
}))

vi.mock('@/gateway/runtime', () => runtime)
vi.mock('@/gateway/auth', () => auth)
vi.mock('@/gateway/utils', () => ({
  sendJson: (_res: ServerResponse, status: number, body: unknown) => sent.push({ status, body }),
}))

import { handleHealthCheck, handleReadinessCheck } from './health'

const req = {} as IncomingMessage
const res = {} as ServerResponse

describe('liveness and readiness', () => {
  beforeEach(() => {
    sent.length = 0
    runtime.isSupergraphReady.mockReturnValue(true)
    runtime.hasCompositionGivenUp.mockReturnValue(false)
    auth.isInitialized.mockReturnValue(true)
  })

  it('reports live while the composition worker can still be restarted', () => {
    handleHealthCheck(req, res)
    expect(sent).toEqual([{ status: 200, body: { status: 'ok' } }])
  })

  it('fails liveness once composition has given up, so the container is restarted', () => {
    runtime.hasCompositionGivenUp.mockReturnValue(true)
    handleHealthCheck(req, res)
    expect(sent[0]).toMatchObject({ status: 503, body: { status: 'unhealthy' } })
  })

  it('names the exhausted restart schedule as the readiness reason', () => {
    runtime.isSupergraphReady.mockReturnValue(false)
    runtime.hasCompositionGivenUp.mockReturnValue(true)
    handleReadinessCheck(req, res)
    expect(sent[0]).toMatchObject({
      status: 503,
      body: { reason: expect.stringMatching(/gave up/i) },
    })
  })

  it('still distinguishes a schema that has not composed yet', () => {
    runtime.isSupergraphReady.mockReturnValue(false)
    handleReadinessCheck(req, res)
    expect(sent[0]).toMatchObject({ status: 503, body: { reason: 'Supergraph not yet composed' } })
  })
})
