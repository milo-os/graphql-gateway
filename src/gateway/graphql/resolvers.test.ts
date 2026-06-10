import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GraphQLError } from 'graphql'

// Resolvers call getOriginalFetch() to bypass the global mTLS-wrapped fetch.
// Mock it to return whatever globalThis.fetch is at call-time so the existing
// vi.stubGlobal('fetch', spy) plumbing in each describe block continues to
// work without the test having to thread a mock through the auth module.
vi.mock('@/gateway/auth', () => ({
  getK8sServer: () => 'https://k8s.test',
  getOriginalFetch: () => globalThis.fetch,
}))

vi.mock('@/gateway/services/geolocation', () => ({
  lookupIp: vi.fn((ip: string) => ({
    city: 'Mountain View',
    country: 'United States',
    countryCode: 'US',
    formatted: `${ip}@Mountain View, United States`,
  })),
}))

vi.mock('@/gateway/services/user-agent', () => ({
  parseUserAgent: vi.fn((ua: string) => ({
    browser: 'TestBrowser',
    os: 'TestOS',
    formatted: `parsed:${ua}`,
  })),
}))

vi.mock('@/shared/utils', () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

import { additionalResolvers } from './resolvers'

type Resolvers = typeof additionalResolvers
type SessionsResolver = NonNullable<Resolvers['Query']>['sessions']
type DeleteResolver = NonNullable<Resolvers['Mutation']>['deleteSession']
type ServiceConsumersResolver = NonNullable<Resolvers['Query']>['serviceConsumers']

const ctx = (overrides: Record<string, string> = {}) => ({
  headers: { authorization: 'Bearer test', ...overrides },
})

// Mirrors what graphql-yoga puts on context for incoming HTTP requests.
const yogaCtx = (overrides: Record<string, string> = {}) => ({
  request: {
    headers: new Headers({ authorization: 'Bearer test', ...overrides }),
  },
})

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const callSessions = (args: { userID?: string } = {}, context: ReturnType<typeof ctx> = ctx()) =>
  (additionalResolvers.Query!.sessions as SessionsResolver)(null, args, context)

const callDeleteSession = (args: { id: string }, context: ReturnType<typeof ctx> = ctx()) =>
  (additionalResolvers.Mutation!.deleteSession as DeleteResolver)(null, args, context)

const callServiceConsumers = (
  args: { producerProject: string },
  context: ReturnType<typeof ctx> = ctx()
) => (additionalResolvers.Query!.serviceConsumers as ServiceConsumersResolver)(null, args, context)

// Routes fetch responses by URL so the consumer-list call and the per-project
// lookups can be stubbed independently within a single resolver invocation.
const routedFetch = (routes: {
  consumers?: Response
  projects?: Record<string, Response>
  fallback?: Response
}) =>
  vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.includes('/serviceconsumers')) {
      return Promise.resolve(routes.consumers ?? jsonResponse({ items: [] }))
    }
    const projectMatch = url.match(/\/projects\/([^/?]+)$/)
    if (projectMatch) {
      const name = decodeURIComponent(projectMatch[1])
      return Promise.resolve(routes.projects?.[name] ?? jsonResponse({}, 404))
    }
    return Promise.resolve(routes.fallback ?? jsonResponse({}, 404))
  })

describe('Query.sessions', () => {
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('calls milo at the expected URL forwarding the Authorization header', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ items: [] }))
    await callSessions()

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe('https://k8s.test/apis/identity.miloapis.com/v1alpha1/sessions')
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer test',
      Accept: 'application/json',
    })
  })

  it('reads headers from the yoga-style context.request.headers shape', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ items: [] }))
    await (additionalResolvers.Query!.sessions as SessionsResolver)(
      null,
      {},
      yogaCtx({
        'x-resource-endpoint-prefix': '/apis/iam.miloapis.com/v1alpha1/users/u1/control-plane',
      }) as Parameters<SessionsResolver>[2]
    )

    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe(
      'https://k8s.test/apis/iam.miloapis.com/v1alpha1/users/u1/control-plane/apis/identity.miloapis.com/v1alpha1/sessions'
    )
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer test',
    })
  })

  it('omits the Authorization header entirely when no token is on the context', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ items: [] }))
    await (additionalResolvers.Query!.sessions as SessionsResolver)(null, {}, {
      headers: {},
    } as Parameters<SessionsResolver>[2])

    const [, init] = fetchSpy.mock.calls[0]
    const sent = (init as RequestInit).headers as Record<string, string>
    expect(sent.Authorization).toBeUndefined()
    expect(sent.Accept).toBe('application/json')
  })

  it('honours x-resource-endpoint-prefix when present', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ items: [] }))
    await callSessions({}, ctx({ 'x-resource-endpoint-prefix': '/projects/p1' }))

    const [url] = fetchSpy.mock.calls[0]
    expect(url).toBe('https://k8s.test/projects/p1/apis/identity.miloapis.com/v1alpha1/sessions')
  })

  it('forwards userID as a status.userUID field selector', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ items: [] }))
    await callSessions({ userID: 'target-user' })

    const [url] = fetchSpy.mock.calls[0]
    expect(url).toBe(
      'https://k8s.test/apis/identity.miloapis.com/v1alpha1/sessions?fieldSelector=status.userUID%3Dtarget-user'
    )
  })

  it('enriches each session with parsed user-agent and resolved location', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        items: [
          {
            metadata: { name: 'sess-1' },
            status: {
              userUID: 'user-42',
              provider: 'zitadel',
              ip: '8.8.8.8',
              fingerprintID: 'fp-1',
              createdAt: '2026-04-28T10:00:00Z',
              lastUpdatedAt: '2026-04-28T11:00:00Z',
              userAgent: 'Mozilla/5.0',
            },
          },
        ],
      })
    )

    const result = await callSessions()
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      id: 'sess-1',
      userUID: 'user-42',
      provider: 'zitadel',
      ipAddress: '8.8.8.8',
      fingerprintID: 'fp-1',
      createdAt: '2026-04-28T10:00:00Z',
      lastUpdatedAt: '2026-04-28T11:00:00Z',
      userAgent: { browser: 'TestBrowser', os: 'TestOS', formatted: 'parsed:Mozilla/5.0' },
      location: expect.objectContaining({ city: 'Mountain View', countryCode: 'US' }),
    })
  })

  it('skips enrichment when ip and userAgent are absent', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        items: [
          {
            metadata: { name: 'sess-2' },
            status: { userUID: 'u', provider: 'zitadel', createdAt: 'now' },
          },
        ],
      })
    )

    const [session] = await callSessions()
    expect(session.userAgent).toBeNull()
    expect(session.location).toBeNull()
    expect(session.ipAddress).toBeNull()
    expect(session.fingerprintID).toBeNull()
  })

  it('returns an empty list on non-2xx responses', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('boom', { status: 500 }))
    expect(await callSessions()).toEqual([])
  })

  it('returns an empty list when fetch throws', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('network down'))
    expect(await callSessions()).toEqual([])
  })

  it('returns an empty list when items is missing from the upstream payload', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({}))
    expect(await callSessions()).toEqual([])
  })
})

describe('Mutation.deleteSession', () => {
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('issues a DELETE to the per-session URL with Authorization', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 200 }))
    await callDeleteSession({ id: 'sess-1' })

    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe('https://k8s.test/apis/identity.miloapis.com/v1alpha1/sessions/sess-1')
    expect((init as RequestInit).method).toBe('DELETE')
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer test',
    })
  })

  it('URL-encodes the id in the path', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 200 }))
    await callDeleteSession({ id: 'a b/c' })

    const [url] = fetchSpy.mock.calls[0]
    expect(url).toBe('https://k8s.test/apis/identity.miloapis.com/v1alpha1/sessions/a%20b%2Fc')
  })

  it('returns true on a 200 response', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 200 }))
    expect(await callDeleteSession({ id: 'sess' })).toBe(true)
  })

  it('returns true on a 404 response (idempotent)', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('not found', { status: 404 }))
    expect(await callDeleteSession({ id: 'sess' })).toBe(true)
  })

  it('throws GraphQLError on non-2xx, non-404 responses', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('boom', { status: 500 }))
    const promise = callDeleteSession({ id: 'sess' })
    await expect(promise).rejects.toBeInstanceOf(GraphQLError)
    await expect(promise).rejects.toMatchObject({
      message: expect.stringContaining('500'),
      extensions: expect.objectContaining({
        code: 'SESSION_DELETE_FAILED',
        status: 500,
      }),
    })
  })
})

describe('Query.serviceConsumers', () => {
  let fetchSpy: ReturnType<typeof vi.fn>

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  const consumer = (over: {
    name: string
    project?: string
    service?: string
    phase?: string
    decision?: string
    message?: string
    createdAt?: string
  }) => ({
    metadata: { name: over.name, creationTimestamp: over.createdAt ?? '2026-06-01T00:00:00Z' },
    spec: {
      ...(over.service ? { serviceRef: { name: over.service } } : {}),
      ...(over.project ? { consumerProjectRef: { name: over.project } } : {}),
      ...(over.decision ? { approval: { decision: over.decision, message: over.message } } : {}),
    },
    status: over.phase ? { phase: over.phase } : {},
  })

  const project = (description?: string) =>
    jsonResponse({
      metadata: description ? { annotations: { 'kubernetes.io/description': description } } : {},
    })

  it('lists consumers in the producer project control plane forwarding Authorization', async () => {
    fetchSpy = routedFetch({ consumers: jsonResponse({ items: [] }) })
    vi.stubGlobal('fetch', fetchSpy)

    await callServiceConsumers({ producerProject: 'prod-proj' })

    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe(
      'https://k8s.test/apis/resourcemanager.miloapis.com/v1alpha1' +
        '/projects/prod-proj/control-plane' +
        '/apis/services.miloapis.com/v1alpha1/serviceconsumers'
    )
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer test',
      Accept: 'application/json',
    })
  })

  it('enriches each consumer with the project display name', async () => {
    fetchSpy = routedFetch({
      consumers: jsonResponse({
        items: [consumer({ name: 'sc-1', project: 'alpha', service: 'svc', phase: 'Active' })],
      }),
      projects: { alpha: project("Alice's Project") },
    })
    vi.stubGlobal('fetch', fetchSpy)

    const result = await callServiceConsumers({ producerProject: 'prod-proj' })
    expect(result).toEqual([
      {
        name: 'sc-1',
        serviceName: 'svc',
        phase: 'Active',
        approvalDecision: null,
        approvalMessage: null,
        requestedAt: '2026-06-01T00:00:00Z',
        consumerProject: { name: 'alpha', displayName: "Alice's Project" },
      },
    ])
  })

  it('maps approval decision and message', async () => {
    fetchSpy = routedFetch({
      consumers: jsonResponse({
        items: [
          consumer({
            name: 'sc-2',
            project: 'beta',
            decision: 'Approved',
            message: 'looks good',
          }),
        ],
      }),
      projects: { beta: project('Beta') },
    })
    vi.stubGlobal('fetch', fetchSpy)

    const [row] = await callServiceConsumers({ producerProject: 'p' })
    expect(row.approvalDecision).toBe('Approved')
    expect(row.approvalMessage).toBe('looks good')
  })

  it('falls back to the raw project name when the annotation is missing', async () => {
    fetchSpy = routedFetch({
      consumers: jsonResponse({ items: [consumer({ name: 'sc-3', project: 'gamma' })] }),
      projects: { gamma: project() },
    })
    vi.stubGlobal('fetch', fetchSpy)

    const [row] = await callServiceConsumers({ producerProject: 'p' })
    expect(row.consumerProject).toEqual({ name: 'gamma', displayName: 'gamma' })
  })

  it('falls back to the raw project name when the project lookup is forbidden', async () => {
    fetchSpy = routedFetch({
      consumers: jsonResponse({ items: [consumer({ name: 'sc-4', project: 'delta' })] }),
      projects: { delta: new Response('forbidden', { status: 403 }) },
    })
    vi.stubGlobal('fetch', fetchSpy)

    const [row] = await callServiceConsumers({ producerProject: 'p' })
    expect(row.consumerProject).toEqual({ name: 'delta', displayName: 'delta' })
  })

  it('fetches each unique project only once', async () => {
    fetchSpy = routedFetch({
      consumers: jsonResponse({
        items: [
          consumer({ name: 'sc-5', project: 'shared' }),
          consumer({ name: 'sc-6', project: 'shared' }),
        ],
      }),
      projects: { shared: project('Shared') },
    })
    vi.stubGlobal('fetch', fetchSpy)

    const result = await callServiceConsumers({ producerProject: 'p' })
    const projectCalls = fetchSpy.mock.calls.filter(([url]) =>
      String(url).match(/\/projects\/shared$/)
    )
    expect(projectCalls).toHaveLength(1)
    expect(result.map((r) => r.consumerProject.displayName)).toEqual(['Shared', 'Shared'])
  })

  it('returns an empty list when the consumer list fetch fails', async () => {
    fetchSpy = routedFetch({ consumers: new Response('boom', { status: 500 }) })
    vi.stubGlobal('fetch', fetchSpy)

    expect(await callServiceConsumers({ producerProject: 'p' })).toEqual([])
  })

  it('returns an empty list when fetch throws', async () => {
    fetchSpy = vi.fn().mockRejectedValue(new Error('network down'))
    vi.stubGlobal('fetch', fetchSpy)

    expect(await callServiceConsumers({ producerProject: 'p' })).toEqual([])
  })
})

describe('Query.parseUserAgent and Query.geolocateIP', () => {
  it('parseUserAgent delegates to the user-agent service', () => {
    const result = additionalResolvers.Query!.parseUserAgent(null, {
      userAgent: 'fake',
    })
    expect(result).toEqual({
      browser: 'TestBrowser',
      os: 'TestOS',
      formatted: 'parsed:fake',
    })
  })

  it('geolocateIP delegates to the geolocation service', () => {
    const result = additionalResolvers.Query!.geolocateIP(null, { ip: '1.1.1.1' })
    expect(result).toMatchObject({
      city: 'Mountain View',
      countryCode: 'US',
    })
  })
})
