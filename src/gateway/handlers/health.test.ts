import type { IncomingMessage, ServerResponse } from 'node:http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { runtime, auth, sent } = vi.hoisted(() => ({
  runtime: {
    isSupergraphReady: vi.fn(() => true),
    gateway: vi.fn(() => Promise.resolve()),
  },
  auth: { isInitialized: vi.fn(() => true) },
  sent: [] as { status: number; body: unknown }[],
}))

vi.mock('@/gateway/runtime', () => runtime)
vi.mock('@/gateway/auth', () => auth)
vi.mock('@/gateway/utils', () => ({
  sendJson: (_res: ServerResponse, status: number, body: unknown) => sent.push({ status, body }),
  parseUrl: (url: string, host: string) => new URL(url, `http://${host}`),
}))
vi.mock('@/shared/utils', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { handleGraphQL } from './graphql'
import { handleHealthCheck, handleReadinessCheck } from './health'
import { handleMetrics } from './metrics'

const req = {} as IncomingMessage
const res = {} as ServerResponse

describe('liveness and readiness', () => {
  beforeEach(() => {
    sent.length = 0
    runtime.isSupergraphReady.mockReturnValue(true)
    auth.isInitialized.mockReturnValue(true)
  })

  it('reports live once the process is serving requests', () => {
    handleHealthCheck(req, res)
    expect(sent).toEqual([{ status: 200, body: { status: 'ok' } }])
  })

  it('reports ready when auth and the supergraph snapshot are loaded', () => {
    handleReadinessCheck(req, res)
    expect(sent).toEqual([{ status: 200, body: { status: 'ready' } }])
  })

  it('is not ready before the committed snapshot is loaded', () => {
    runtime.isSupergraphReady.mockReturnValue(false)
    handleReadinessCheck(req, res)
    expect(sent[0]).toMatchObject({
      status: 503,
      body: { reason: 'Supergraph snapshot not loaded' },
    })
  })

  it('is not ready when K8s auth has not been initialised', () => {
    auth.isInitialized.mockReturnValue(false)
    handleReadinessCheck(req, res)
    expect(sent[0]).toMatchObject({
      status: 503,
      body: { reason: 'K8s auth not initialized' },
    })
  })
})

const RESOURCE_HEADERS = [
  'x-resource-api-group',
  'x-resource-version',
  'x-resource-kind',
  'x-resource-name',
  'x-resource-endpoint-prefix',
] as const

const CLIENT_RESOURCE_HEADERS = {
  'x-resource-api-group': 'client.api.group',
  'x-resource-version': 'v9',
  'x-resource-kind': 'clientkind',
  'x-resource-name': 'client-name',
  'x-resource-endpoint-prefix': '/client/prefix',
}

const graphReq = (url: string, headers: Record<string, string> = {}) =>
  ({
    url,
    method: 'POST',
    headers: { host: 'gateway.test', ...headers },
  }) as unknown as IncomingMessage

describe('GraphQL resource headers', () => {
  beforeEach(() => {
    runtime.gateway.mockClear()
  })

  it('drops every client-supplied x-resource-* header on the root path', async () => {
    const graphqlReq = graphReq('/graphql', CLIENT_RESOURCE_HEADERS)

    await handleGraphQL(graphqlReq, res)

    expect(runtime.gateway).toHaveBeenCalledWith(graphqlReq, res)
    for (const header of RESOURCE_HEADERS) expect(graphqlReq.headers[header]).toBeUndefined()
  })

  it('derives every x-resource-* header from the URL on the scoped path', async () => {
    const graphqlReq = graphReq(
      '/resourcemanager.miloapis.com/v1alpha1/projects/proj-a/graphql',
      CLIENT_RESOURCE_HEADERS
    )

    await handleGraphQL(graphqlReq, res)

    expect(runtime.gateway).toHaveBeenCalledWith(graphqlReq, res)
    expect(graphqlReq.headers).toMatchObject({
      'x-resource-api-group': 'resourcemanager.miloapis.com',
      'x-resource-version': 'v1alpha1',
      'x-resource-kind': 'project',
      'x-resource-name': 'proj-a',
      'x-resource-endpoint-prefix':
        '/apis/resourcemanager.miloapis.com/v1alpha1/projects/proj-a/control-plane',
    })
  })

  it('drops client-supplied x-resource-* headers before forwarding metrics', async () => {
    const metricsReq = graphReq('/metrics', CLIENT_RESOURCE_HEADERS)

    await handleMetrics(metricsReq, res)

    expect(runtime.gateway).toHaveBeenCalledWith(metricsReq, res)
    for (const header of RESOURCE_HEADERS) expect(metricsReq.headers[header]).toBeUndefined()
  })
})
