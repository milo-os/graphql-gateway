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

describe('Query.organizations', () => {
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
  })
  afterEach(() => vi.unstubAllGlobals())

  const callOrganizations = (args: { limit?: number; cursor?: string; search?: string } = {}) =>
    (additionalResolvers.Query!.organizations as (r: null, a: typeof args, c: ReturnType<typeof ctx>) => Promise<unknown>)(null, args, ctx())

  it('lists organizations and maps displayName from annotation', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({
        items: [
          {
            metadata: {
              name: 'acme',
              creationTimestamp: '2024-01-01T00:00:00Z',
              annotations: { 'kubernetes.io/description': 'Acme Corp' },
            },
            spec: { type: 'Standard' },
            status: { conditions: [{ type: 'Ready', status: 'True' }] },
          },
        ],
        metadata: { continue: 'tok123' },
      })
    )

    const result = await callOrganizations({ limit: 10 }) as { items: unknown[]; continueToken: string }
    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({ name: 'acme', displayName: 'Acme Corp', type: 'Standard', state: 'True' })
    expect(result.continueToken).toBe('tok123')
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/apis/resourcemanager.miloapis.com/v1alpha1/organizations?limit=10'),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer test' }) })
    )
  })

  it('falls back to name when description annotation is absent', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ items: [{ metadata: { name: 'plain' }, spec: { type: 'Personal' } }] }))
    const result = await callOrganizations() as { items: { displayName: string }[] }
    expect(result.items[0].displayName).toBe('plain')
  })

  it('passes fieldSelector when search is provided', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ items: [] }))
    await callOrganizations({ search: 'acme' })
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('fieldSelector=metadata.name%3Dacme'),
      expect.anything()
    )
  })

  it('returns empty list on non-ok response', async () => {
    fetchSpy.mockResolvedValue(new Response('{}', { status: 403 }))
    const result = await callOrganizations() as { items: unknown[] }
    expect(result.items).toEqual([])
  })

  it('returns empty list when fetch throws', async () => {
    fetchSpy.mockRejectedValue(new Error('network'))
    const result = await callOrganizations() as { items: unknown[] }
    expect(result.items).toEqual([])
  })
})

describe('Query.organization', () => {
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('fetches a single org by name', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({ metadata: { name: 'acme', annotations: {} }, spec: { type: 'Standard' } })
    )
    const result = await (additionalResolvers.Query!.organization as (r: null, a: { name: string }, c: ReturnType<typeof ctx>) => Promise<unknown>)(null, { name: 'acme' }, ctx()) as { name: string }
    expect(result.name).toBe('acme')
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/organizations/acme'),
      expect.anything()
    )
  })

  it('returns null on 404', async () => {
    fetchSpy.mockResolvedValue(new Response('{}', { status: 404 }))
    const result = await (additionalResolvers.Query!.organization as (r: null, a: { name: string }, c: ReturnType<typeof ctx>) => Promise<unknown>)(null, { name: 'missing' }, ctx())
    expect(result).toBeNull()
  })
})

describe('Query.organizationProjects', () => {
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
  })
  afterEach(() => vi.unstubAllGlobals())

  const callOrgProjects = (args: { orgName: string; limit?: number; cursor?: string }) =>
    (additionalResolvers.Query!.organizationProjects as (r: null, a: typeof args, c: ReturnType<typeof ctx>) => Promise<unknown>)(null, args, ctx())

  it('fetches projects via the org control plane URL', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({
        items: [
          {
            metadata: { name: 'proj-1', annotations: { 'kubernetes.io/description': 'Project One' } },
            spec: { ownerRef: { name: 'acme', kind: 'Organization' } },
          },
        ],
        metadata: {},
      })
    )
    const result = await callOrgProjects({ orgName: 'acme' }) as { items: { name: string; displayName: string; organizationName: string }[] }
    expect(result.items[0]).toMatchObject({ name: 'proj-1', displayName: 'Project One', organizationName: 'acme' })
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/organizations/acme/control-plane/apis/resourcemanager.miloapis.com/v1alpha1/projects'),
      expect.anything()
    )
  })

  it('returns empty list on failure', async () => {
    fetchSpy.mockResolvedValue(new Response('{}', { status: 403 }))
    const result = await callOrgProjects({ orgName: 'acme' }) as { items: unknown[] }
    expect(result.items).toEqual([])
  })
})

describe('Query.organizationMembers', () => {
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
  })
  afterEach(() => vi.unstubAllGlobals())

  const callOrgMembers = (orgName: string) =>
    (additionalResolvers.Query!.organizationMembers as (r: null, a: { orgName: string }, c: ReturnType<typeof ctx>) => Promise<unknown[]>)(null, { orgName }, ctx())

  it('merges members and invitations in parallel', async () => {
    fetchSpy.mockImplementation((url: string) => {
      if (url.includes('organizationmemberships')) {
        return Promise.resolve(jsonResponse({
          items: [{
            metadata: { name: 'mbr-1', creationTimestamp: '2024-01-01T00:00:00Z' },
            spec: { userRef: { name: 'user-1' }, roles: [{ name: 'viewer' }] },
            status: { user: { givenName: 'Ada', familyName: 'Lovelace', email: 'ada@example.com' } },
          }],
        }))
      }
      return Promise.resolve(jsonResponse({
        items: [{
          metadata: { name: 'inv-1', creationTimestamp: '2024-02-01T00:00:00Z' },
          spec: { givenName: 'Bob', familyName: 'Builder', email: 'bob@example.com', roles: [{ name: 'editor' }], state: 'Pending' },
        }],
      }))
    })

    const result = await callOrgMembers('acme')
    expect(result).toHaveLength(2)
    expect(result.find((m: unknown) => (m as { type: string }).type === 'member')).toMatchObject({
      name: 'mbr-1', email: 'ada@example.com', givenName: 'Ada', roles: ['viewer'], type: 'member',
      userName: 'user-1',
    })
    expect(result.find((m: unknown) => (m as { type: string }).type === 'invitation')).toMatchObject({
      name: 'inv-1', email: 'bob@example.com', invitationState: 'Pending', type: 'invitation',
      userName: null,
    })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('returns partial results when one fetch fails', async () => {
    fetchSpy.mockImplementation((url: string) => {
      if (url.includes('organizationmemberships')) {
        return Promise.resolve(new Response('{}', { status: 403 }))
      }
      return Promise.resolve(jsonResponse({ items: [{ metadata: { name: 'inv-1' }, spec: { email: 'x@y.com', roles: [] } }] }))
    })
    const result = await callOrgMembers('acme')
    expect(result).toHaveLength(1)
    expect((result[0] as { type: string }).type).toBe('invitation')
  })

  it('returns empty list when fetch throws', async () => {
    fetchSpy.mockRejectedValue(new Error('network'))
    expect(await callOrgMembers('acme')).toEqual([])
  })
})

describe('Query.projects', () => {
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('lists all projects', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({
      items: [{ metadata: { name: 'proj-a', annotations: {} }, spec: { ownerRef: { name: 'acme' } } }],
      metadata: {},
    }))
    const result = await (additionalResolvers.Query!.projects as (r: null, a: object, c: ReturnType<typeof ctx>) => Promise<{ items: { name: string }[] }>)(null, {}, ctx())
    expect(result.items[0].name).toBe('proj-a')
  })

  it('returns empty list on non-ok response', async () => {
    fetchSpy.mockResolvedValue(new Response('{}', { status: 500 }))
    const result = await (additionalResolvers.Query!.projects as (r: null, a: object, c: ReturnType<typeof ctx>) => Promise<{ items: unknown[] }>)(null, {}, ctx())
    expect(result.items).toEqual([])
  })
})

describe('Query.project', () => {
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('fetches a single project by name', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({
      metadata: { name: 'proj-a', annotations: { 'kubernetes.io/description': 'Alpha' } },
      spec: { ownerRef: { name: 'acme' } },
    }))
    const result = await (additionalResolvers.Query!.project as (r: null, a: { name: string }, c: ReturnType<typeof ctx>) => Promise<{ name: string; displayName: string } | null>)(null, { name: 'proj-a' }, ctx())
    expect(result).toMatchObject({ name: 'proj-a', displayName: 'Alpha' })
    expect(fetchSpy).toHaveBeenCalledWith(expect.stringContaining('/projects/proj-a'), expect.anything())
  })

  it('returns null on 404', async () => {
    fetchSpy.mockResolvedValue(new Response('{}', { status: 404 }))
    const result = await (additionalResolvers.Query!.project as (r: null, a: { name: string }, c: ReturnType<typeof ctx>) => Promise<unknown>)(null, { name: 'gone' }, ctx())
    expect(result).toBeNull()
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

// ─── Quota resolvers ──────────────────────────────────────────────────────────

const mockBucket = (resourceType: string, overrides: Record<string, unknown> = {}) => ({
  metadata: { name: `bucket-${resourceType}`, namespace: 'organization-acme' },
  spec: {
    resourceType,
    consumerRef: { apiGroup: 'resourcemanager.miloapis.com', kind: 'Organization', name: 'acme' },
  },
  status: { allocated: 3, limit: 10, available: 7 },
  ...overrides,
})

const mockRegistration = (resourceType: string, overrides: Record<string, unknown> = {}) => ({
  metadata: {
    name: `reg-${resourceType}`,
    annotations: { 'kubernetes.io/display-name': `Display ${resourceType}`, 'kubernetes.io/description': `Desc ${resourceType}` },
    labels: { 'services.miloapis.com/owner': 'core.miloapis.com' },
  },
  spec: { resourceType, type: 'Allocation' },
  ...overrides,
})

describe('Query.orgQuotaBuckets', () => {
  let fetchSpy: ReturnType<typeof vi.fn>
  beforeEach(() => { fetchSpy = vi.fn(); vi.stubGlobal('fetch', fetchSpy) })
  afterEach(() => vi.unstubAllGlobals())

  const call = (orgName: string) =>
    (additionalResolvers.Query!.orgQuotaBuckets as (r: null, a: { orgName: string }, c: ReturnType<typeof ctx>) => Promise<unknown>)(null, { orgName }, ctx())

  it('joins buckets with registrations and resolves display names', async () => {
    fetchSpy.mockImplementation((url: string) => {
      if (url.includes('allowancebuckets'))
        return Promise.resolve(jsonResponse({ items: [mockBucket('core.miloapis.com/quotas')] }))
      return Promise.resolve(jsonResponse({ items: [mockRegistration('core.miloapis.com/quotas')] }))
    })
    const result = await call('acme') as { items: unknown[] }
    expect(result.items).toHaveLength(1)
    expect((result.items[0] as Record<string, unknown>).displayName).toBe('Display core.miloapis.com/quotas')
    expect((result.items[0] as Record<string, unknown>).serviceDisplayName).toBe('Platform Core')
    expect((result.items[0] as Record<string, unknown>).allocated).toBe(3)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('filters out Feature-type registrations', async () => {
    fetchSpy.mockImplementation((url: string) => {
      if (url.includes('allowancebuckets'))
        return Promise.resolve(jsonResponse({ items: [mockBucket('some.com/feature')] }))
      return Promise.resolve(jsonResponse({ items: [{ ...mockRegistration('some.com/feature'), spec: { resourceType: 'some.com/feature', type: 'Feature' } }] }))
    })
    const result = await call('acme') as { items: unknown[] }
    expect(result.items).toHaveLength(0)
  })

  it('falls back to hardcoded display name when annotation absent', async () => {
    fetchSpy.mockImplementation((url: string) => {
      if (url.includes('allowancebuckets'))
        return Promise.resolve(jsonResponse({ items: [mockBucket('compute.datumapis.com/instances')] }))
      return Promise.resolve(jsonResponse({ items: [{ metadata: { name: 'r', annotations: {}, labels: { 'services.miloapis.com/owner': 'compute.datumapis.com' } }, spec: { resourceType: 'compute.datumapis.com/instances', type: 'Allocation' } }] }))
    })
    const result = await call('acme') as { items: { displayName: string; serviceDisplayName: string }[] }
    expect(result.items[0].displayName).toBe('Instances')
    expect(result.items[0].serviceDisplayName).toBe('Compute')
  })

  it('returns empty list when buckets fetch fails', async () => {
    fetchSpy.mockImplementation((url: string) => {
      if (url.includes('allowancebuckets')) return Promise.resolve(new Response('{}', { status: 403 }))
      return Promise.resolve(jsonResponse({ items: [] }))
    })
    const result = await call('acme') as { items: unknown[] }
    expect(result.items).toEqual([])
  })

  it('returns empty list on network error', async () => {
    fetchSpy.mockRejectedValue(new Error('network'))
    const result = await call('acme') as { items: unknown[] }
    expect(result.items).toEqual([])
  })
})

describe('Query.projectQuotaBuckets', () => {
  let fetchSpy: ReturnType<typeof vi.fn>
  beforeEach(() => { fetchSpy = vi.fn(); vi.stubGlobal('fetch', fetchSpy) })
  afterEach(() => vi.unstubAllGlobals())

  it('fetches from project control plane', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ items: [] }))
    const result = await (additionalResolvers.Query!.projectQuotaBuckets as (r: null, a: { projectName: string }, c: ReturnType<typeof ctx>) => Promise<unknown>)(null, { projectName: 'my-proj' }, ctx()) as { items: unknown[] }
    expect(result.items).toEqual([])
    const urls: string[] = fetchSpy.mock.calls.map((c: unknown[]) => c[0] as string)
    expect(urls.some((u) => u.includes('/projects/my-proj/control-plane'))).toBe(true)
  })
})

describe('Query.orgQuotaGrants', () => {
  let fetchSpy: ReturnType<typeof vi.fn>
  beforeEach(() => { fetchSpy = vi.fn(); vi.stubGlobal('fetch', fetchSpy) })
  afterEach(() => vi.unstubAllGlobals())

  const call = (orgName: string) =>
    (additionalResolvers.Query!.orgQuotaGrants as (r: null, a: { orgName: string }, c: ReturnType<typeof ctx>) => Promise<unknown>)(null, { orgName }, ctx())

  const mockGrant = () => ({
    metadata: { name: 'grant-1', namespace: 'organization-acme', creationTimestamp: '2024-01-01T00:00:00Z', labels: {} },
    spec: { allowances: [{ resourceType: 'core.miloapis.com/quotas', buckets: [{ amount: 5 }, { amount: 3 }] }] },
    status: { conditions: [{ type: 'Active', status: 'True', message: 'ok' }] },
  })

  it('flattens allowances and resolves display names', async () => {
    fetchSpy.mockImplementation((url: string) => {
      if (url.includes('resourcegrants'))
        return Promise.resolve(jsonResponse({ items: [mockGrant()] }))
      return Promise.resolve(jsonResponse({ items: [mockRegistration('core.miloapis.com/quotas')] }))
    })
    const result = await call('acme') as { items: { allowances: { resourceType: string; amount: number; displayName: string }[]; autoCreated: boolean; conditions: unknown[] }[] }
    expect(result.items).toHaveLength(1)
    expect(result.items[0].allowances).toHaveLength(1)
    expect(result.items[0].allowances[0].amount).toBe(8) // 5 + 3
    expect(result.items[0].allowances[0].displayName).toBe('Display core.miloapis.com/quotas')
    expect(result.items[0].autoCreated).toBe(false)
    expect(result.items[0].conditions).toHaveLength(1)
  })

  it('marks autoCreated grants', async () => {
    const autoGrant = {
      metadata: { name: 'auto-1', namespace: 'organization-acme', labels: { 'quota.miloapis.com/auto-created': 'true' } },
      spec: { allowances: [] },
      status: { conditions: [] },
    }
    fetchSpy.mockImplementation((url: string) => {
      if (url.includes('resourcegrants')) return Promise.resolve(jsonResponse({ items: [autoGrant] }))
      return Promise.resolve(jsonResponse({ items: [] }))
    })
    const result = await call('acme') as { items: { autoCreated: boolean }[] }
    expect(result.items[0].autoCreated).toBe(true)
  })

  it('returns empty list when grants fetch fails', async () => {
    fetchSpy.mockImplementation((url: string) => {
      if (url.includes('resourcegrants')) return Promise.resolve(new Response('{}', { status: 500 }))
      return Promise.resolve(jsonResponse({ items: [] }))
    })
    const result = await call('acme') as { items: unknown[] }
    expect(result.items).toEqual([])
  })
})

describe('Query.projectQuotaGrants', () => {
  let fetchSpy: ReturnType<typeof vi.fn>
  beforeEach(() => { fetchSpy = vi.fn(); vi.stubGlobal('fetch', fetchSpy) })
  afterEach(() => vi.unstubAllGlobals())

  it('fetches from project control plane', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ items: [] }))
    const result = await (additionalResolvers.Query!.projectQuotaGrants as (r: null, a: { projectName: string }, c: ReturnType<typeof ctx>) => Promise<unknown>)(null, { projectName: 'my-proj' }, ctx()) as { items: unknown[] }
    expect(result.items).toEqual([])
    const urls: string[] = fetchSpy.mock.calls.map((c: unknown[]) => c[0] as string)
    expect(urls.some((u) => u.includes('/projects/my-proj/control-plane'))).toBe(true)
  })
})
