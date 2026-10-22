import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as nodeFs from 'node:fs'

const sdlPath = '/repo/supergraph/supergraph.graphql'
const sdl = 'type Query { ok: Boolean }'

const { readFileSync, log, fetchMock, auth } = vi.hoisted(() => ({
  readFileSync: vi.fn(),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  fetchMock: vi.fn(),
  auth: {
    getK8sServer: vi.fn(() => 'https://k8s.test'),
    getMTLSFetch: vi.fn(),
  },
}))

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof nodeFs>()),
  readFileSync,
}))
vi.mock('@/gateway/config', () => ({ env: { supergraphPath: sdlPath } }))
vi.mock('@/gateway/auth', () => auth)
vi.mock('@/shared/utils', () => ({ log }))

import { fetchOpenApiPaths, getSubgraphName, stableSpecFetch } from './compose'

const discovery = (paths: string[]) =>
  new Response(JSON.stringify({ paths: Object.fromEntries(paths.map((path) => [path, {}])) }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

/** A Response body can only be read once, so each call needs a fresh one. */
const respondWith = (paths: string[]) => {
  fetchMock.mockImplementation(() => Promise.resolve(discovery(paths)))
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

describe('supergraph snapshot', () => {
  beforeEach(() => {
    readFileSync.mockImplementation((path: string) => {
      if (path.endsWith('supergraph.graphql')) return sdl
      if (path.endsWith('paths.json')) return JSON.stringify({ paths: ['apis/a/v1', 'api/v1'] })
      throw new Error(`unexpected read ${path}`)
    })
    auth.getMTLSFetch.mockReturnValue(fetchMock)
    respondWith(['api/v1', 'apis/a/v1'])
    vi.resetModules()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  const load = async () => {
    const mod = await import('./supergraph')
    await mod.initializeGateway()
    await flush()
    return mod
  }

  it('serves the committed SDL and marks readiness without composing', async () => {
    const mod = await load()

    expect(readFileSync).toHaveBeenCalledWith(sdlPath, 'utf8')
    expect(mod.getSupergraph()).toBe(sdl)
    expect(mod.isSupergraphReady()).toBe(true)
    expect(log.info).toHaveBeenCalledWith(
      'Supergraph snapshot loaded',
      expect.objectContaining({ path: sdlPath, bytes: sdl.length })
    )
  })

  it('fails boot when the snapshot is empty', async () => {
    readFileSync.mockReturnValue('\n  \n')
    const mod = await import('./supergraph')

    await expect(mod.initializeGateway()).rejects.toThrow(/empty/)
    expect(mod.isSupergraphReady()).toBe(false)
  })

  it('fails boot when the snapshot file is missing', async () => {
    readFileSync.mockImplementation(() => {
      throw new Error(`ENOENT: no such file or directory, open '${sdlPath}'`)
    })
    const mod = await import('./supergraph')

    await expect(mod.initializeGateway()).rejects.toThrow(/supergraph\.graphql/)
    expect(mod.isSupergraphReady()).toBe(false)
  })

  it('fails boot when the snapshot is not valid SDL', async () => {
    readFileSync.mockReturnValue('schema { query: Query ')
    const mod = await import('./supergraph')

    await expect(mod.initializeGateway()).rejects.toThrow(/not valid SDL/)
    expect(mod.isSupergraphReady()).toBe(false)
  })

  it('warns, but keeps the schema, when the live paths differ from the snapshot', async () => {
    respondWith(['api/v2', 'apis/a/v1'])
    const mod = await load()

    const diff = await mod.checkSnapshotDrift()

    expect(diff).toEqual({ added: ['api/v2'], removed: ['api/v1'] })
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringMatching(/out of date/i),
      expect.objectContaining({ added: ['api/v2'], removed: ['api/v1'] })
    )
    expect(mod.isSupergraphReady()).toBe(true)
  })

  it('stays quiet when the snapshot matches the live paths', async () => {
    const mod = await load()

    const diff = await mod.checkSnapshotDrift()

    expect(diff).toEqual({ added: [], removed: [] })
    expect(log.info).toHaveBeenCalledWith('Supergraph snapshot matches the live OpenAPI paths', {
      paths: 2,
    })
  })

  it('never fails startup when the drift check cannot reach the API server', async () => {
    fetchMock.mockRejectedValue(new Error('connection refused'))
    const mod = await load()

    const diff = await mod.checkSnapshotDrift()

    expect(diff).toBeNull()
    expect(log.warn).toHaveBeenCalledWith(
      'Could not check supergraph snapshot drift',
      expect.objectContaining({ error: 'connection refused' })
    )
    expect(mod.isSupergraphReady()).toBe(true)
  })

  it('treats a non-2xx discovery response as a warning, not a failure', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(new Response('nope', { status: 403, statusText: 'Forbidden' }))
    )
    const mod = await load()

    const diff = await mod.checkSnapshotDrift()

    expect(diff).toBeNull()
    expect(log.warn).toHaveBeenCalledWith(
      'Could not check supergraph snapshot drift',
      expect.objectContaining({ error: expect.stringMatching(/403/) })
    )
  })
})

describe('composition from a live API server', () => {
  const fakeFetch = (body: unknown, status = 200): typeof fetch =>
    (() =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        })
      )) as unknown as typeof fetch

  it('derives a stable subgraph name from the discovery path', () => {
    expect(getSubgraphName('apis/usage.billing.miloapis.com/v1')).toBe(
      'APIS_USAGE_BILLING_MILOAPIS_COM_V1'
    )
    expect(getSubgraphName('api/v1')).toBe('API_V1')
  })

  it('reads the path list from the discovery document', async () => {
    const paths = await fetchOpenApiPaths(
      fakeFetch({ paths: { 'api/v1': {}, 'apis/a/v1': {} } }),
      'https://k8s.test/'
    )

    expect(paths).toEqual(['api/v1', 'apis/a/v1'])
  })

  it('fails the snapshot run when discovery is rejected', async () => {
    await expect(fetchOpenApiPaths(fakeFetch({}, 401), 'https://k8s.test')).rejects.toThrow(/401/)
  })

  it('fails the snapshot run when discovery has no paths', async () => {
    await expect(fetchOpenApiPaths(fakeFetch({}), 'https://k8s.test')).rejects.toThrow(/no paths/)
  })
  const CORE = 'https://k8s.test/openapi/v3/api/v1'
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const sequence = (...responses: Response[]) => {
    const calls = vi.fn(() => Promise.resolve(responses.shift() ?? json({}, 599)))
    return calls
  }

  it('retries a spec fetch that fails with a server error', async () => {
    const inner = sequence(json({}, 502), json({ info: { title: 'Kubernetes' } }))
    const res = await stableSpecFetch(inner as unknown as typeof fetch, { delayMs: 0 })(
      'https://k8s.test/openapi/v3/apis/a/v1'
    )
    expect(res.status).toBe(200)
    expect(inner).toHaveBeenCalledTimes(2)
  })

  it('re-fetches the core spec until Milo serves its own instead of another server', async () => {
    const inner = sequence(
      json({ info: { title: 'Activity' }, paths: {} }),
      json({ info: { title: 'Kubernetes' }, paths: { '/api/v1/namespaces': {} } })
    )
    const res = await stableSpecFetch(inner as unknown as typeof fetch, { delayMs: 0 })(CORE)
    expect(((await res.json()) as { info: { title: string } }).info.title).toBe('Kubernetes')
    expect(inner).toHaveBeenCalledTimes(2)
  })

  it('fails the snapshot run when the core spec never comes from Milo', async () => {
    const inner = vi.fn(() => Promise.resolve(json({ info: { title: 'Activity' } })))
    await expect(
      stableSpecFetch(inner as unknown as typeof fetch, { delayMs: 0, attempts: 3 })(CORE)
    ).rejects.toThrow(/core spec/)
    expect(inner).toHaveBeenCalledTimes(3)
  })
})
