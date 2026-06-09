import { GraphQLError } from 'graphql'
import { parseUserAgent } from '@/gateway/services/user-agent'
import { lookupIp } from '@/gateway/services/geolocation'
import { getK8sServer, getOriginalFetch } from '@/gateway/auth'
import { log } from '@/shared/utils'

/**
 * Hive Gateway runs on graphql-yoga, which exposes incoming request headers
 * via `context.request.headers` (a Web Headers instance). The federated
 * mesh-mapping resolvers in compose-worker.ts read headers via the
 * `context.headers[name]` flat-object shape provided by graphql-mesh's
 * runtime. Hand-written local resolvers see only the yoga shape, so we
 * support both and fall back to the empty string when neither is present.
 */
interface ResolverContext {
  request?: { headers?: Headers }
  headers?: Record<string, string | undefined>
}

function getHeader(context: ResolverContext, name: string): string {
  const yogaValue = context.request?.headers?.get?.(name)
  if (yogaValue) return yogaValue
  const meshValue = context.headers?.[name] ?? context.headers?.[name.toLowerCase()]
  return meshValue ?? ''
}

interface UpstreamSession {
  metadata?: {
    name?: string
    creationTimestamp?: string
  }
  status?: {
    userUID?: string
    provider?: string
    ip?: string
    fingerprintID?: string
    createdAt?: string
    lastUpdatedAt?: string
    userAgent?: string
  }
}

interface UpstreamSessionList {
  items?: UpstreamSession[]
}

function enrichSession(session: UpstreamSession) {
  const status = session.status ?? {}
  const id = session.metadata?.name ?? 'unknown'
  const ipAddress = status.ip ?? null
  const rawUserAgent = status.userAgent ?? null

  return {
    id,
    userUID: status.userUID ?? '',
    provider: status.provider ?? '',
    ipAddress,
    fingerprintID: status.fingerprintID ?? null,
    createdAt: status.createdAt ?? session.metadata?.creationTimestamp ?? '',
    lastUpdatedAt: status.lastUpdatedAt ?? null,
    userAgent: rawUserAgent ? parseUserAgent(rawUserAgent) : null,
    location: ipAddress ? lookupIp(ipAddress) : null,
  }
}

function sessionsURL(context: ResolverContext, options: { name?: string; userID?: string } = {}) {
  const server = getK8sServer()
  const endpointPrefix = getHeader(context, 'x-resource-endpoint-prefix')
  const base = `${server}${endpointPrefix}/apis/identity.miloapis.com/v1alpha1/sessions`
  if (options.name) return `${base}/${encodeURIComponent(options.name)}`
  if (options.userID) {
    const params = new URLSearchParams({
      fieldSelector: `status.userUID=${options.userID}`,
    })
    return `${base}?${params.toString()}`
  }
  return base
}

const PROJECT_DESCRIPTION_ANNOTATION = 'kubernetes.io/description'

interface UpstreamServiceConsumer {
  metadata?: { name?: string; creationTimestamp?: string }
  spec?: {
    serviceRef?: { name?: string }
    consumerProjectRef?: { name?: string }
    approval?: { decision?: string; message?: string }
  }
  status?: { phase?: string }
}

interface UpstreamServiceConsumerList {
  items?: UpstreamServiceConsumer[]
}

interface UpstreamProject {
  metadata?: { annotations?: Record<string, string> }
}

// ServiceConsumers live in the producer project's control plane, not at the
// core level — hence the /projects/<producer>/control-plane prefix. The list
// is cluster-scoped within that control plane (no namespace).
function serviceConsumersURL(producerProject: string) {
  const server = getK8sServer()
  return (
    `${server}/apis/resourcemanager.miloapis.com/v1alpha1` +
    `/projects/${encodeURIComponent(producerProject)}/control-plane` +
    `/apis/services.miloapis.com/v1alpha1/serviceconsumers`
  )
}

// The Project object itself is read at the core resourcemanager API (no
// control-plane prefix) — that's where its annotations live.
function projectURL(name: string) {
  const server = getK8sServer()
  return `${server}/apis/resourcemanager.miloapis.com/v1alpha1/projects/${encodeURIComponent(name)}`
}

/**
 * Resolves the human-readable display name for each unique consumer project.
 *
 * Returns a name -> displayName map. Per-project failures (missing annotation,
 * 403, network) are swallowed so the project simply falls back to its raw
 * name later — a single inaccessible project never fails the whole query.
 * Fetches run in parallel; there is no gateway-level dataloader.
 */
async function resolveProjectDisplayNames(
  projectNames: string[],
  headers: Record<string, string>
): Promise<Map<string, string>> {
  const fetchFn = getOriginalFetch()
  const displayNames = new Map<string, string>()

  await Promise.all(
    projectNames.map(async (name) => {
      try {
        const response = await fetchFn(projectURL(name), { headers })
        if (!response.ok) {
          log.warn('milo project fetch failed', { project: name, status: response.status })
          return
        }
        const project = (await response.json()) as UpstreamProject
        const description = project.metadata?.annotations?.[PROJECT_DESCRIPTION_ANNOTATION]
        if (description) displayNames.set(name, description)
      } catch (error) {
        log.warn('milo project fetch threw', {
          project: name,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    })
  )

  return displayNames
}

export const additionalResolvers = {
  Query: {
    parseUserAgent: (_root: unknown, args: { userAgent: string }) => {
      return parseUserAgent(args.userAgent)
    },

    geolocateIP: (_root: unknown, args: { ip: string }) => {
      return lookupIp(args.ip)
    },

    sessions: async (_root: unknown, args: { userID?: string }, context: ResolverContext) => {
      try {
        const url = sessionsURL(context, { userID: args.userID })
        const authorization = getHeader(context, 'authorization')

        // Use the pre-override fetch so no client cert is presented. milo's
        // user-scoped path needs to authenticate the *end user* via bearer
        // token; with the gateway's mTLS cert in the way, X509 auth wins
        // first and the user-scoped RBAC check 403s.
        const response = await getOriginalFetch()(url, {
          headers: {
            ...(authorization ? { Authorization: authorization } : {}),
            Accept: 'application/json',
          },
        })

        if (!response.ok) {
          log.warn('milo sessions fetch failed', {
            status: response.status,
            url,
            hasAuthorization: !!authorization,
          })
          return []
        }

        const body = (await response.json()) as UpstreamSessionList
        return (body.items ?? []).map(enrichSession)
      } catch (error) {
        log.error('Sessions resolver failed', {
          error: error instanceof Error ? error.message : String(error),
        })
        return []
      }
    },

    serviceConsumers: async (
      _root: unknown,
      args: { producerProject: string },
      context: ResolverContext
    ) => {
      try {
        const authorization = getHeader(context, 'authorization')
        // Use the pre-override fetch (bearer, not the gateway's mTLS cert) so
        // milo authorizes the end user — same reasoning as Query.sessions.
        const fetchFn = getOriginalFetch()
        const headers = {
          ...(authorization ? { Authorization: authorization } : {}),
          Accept: 'application/json',
        }

        const url = serviceConsumersURL(args.producerProject)
        const response = await fetchFn(url, { headers })
        if (!response.ok) {
          log.warn('milo serviceConsumers fetch failed', {
            status: response.status,
            url,
            hasAuthorization: !!authorization,
          })
          return []
        }

        const body = (await response.json()) as UpstreamServiceConsumerList
        const consumers = body.items ?? []

        const projectNames = [
          ...new Set(
            consumers
              .map((c) => c.spec?.consumerProjectRef?.name)
              .filter((name): name is string => !!name)
          ),
        ]
        const displayNames = await resolveProjectDisplayNames(projectNames, headers)

        return consumers.map((consumer) => {
          const projectName = consumer.spec?.consumerProjectRef?.name ?? ''
          return {
            name: consumer.metadata?.name ?? '',
            serviceName: consumer.spec?.serviceRef?.name ?? null,
            phase: consumer.status?.phase ?? null,
            approvalDecision: consumer.spec?.approval?.decision ?? null,
            approvalMessage: consumer.spec?.approval?.message ?? null,
            requestedAt: consumer.metadata?.creationTimestamp ?? null,
            consumerProject: {
              name: projectName,
              displayName: displayNames.get(projectName) || projectName,
            },
          }
        })
      } catch (error) {
        log.error('ServiceConsumers resolver failed', {
          error: error instanceof Error ? error.message : String(error),
        })
        return []
      }
    },
  },

  Mutation: {
    deleteSession: async (_root: unknown, args: { id: string }, context: ResolverContext) => {
      const url = sessionsURL(context, { name: args.id })
      const authorization = getHeader(context, 'authorization')

      // Same reason as Query.sessions — bypass the mTLS-wrapped global
      // fetch so milo authenticates the user via bearer token rather than
      // the gateway's client cert.
      const response = await getOriginalFetch()(url, {
        method: 'DELETE',
        headers: {
          ...(authorization ? { Authorization: authorization } : {}),
          Accept: 'application/json',
        },
      })

      // 200/202/204 are success; 404 means the session is already gone, which
      // we treat as success so the mutation is idempotent for retries.
      if (response.ok || response.status === 404) {
        return true
      }

      const detail = await response.text().catch(() => '')
      log.warn('milo deleteSession failed', {
        status: response.status,
        url,
        detail,
        hasAuthorization: !!authorization,
      })
      throw new GraphQLError(`Failed to delete session: ${response.status}`, {
        extensions: { code: 'SESSION_DELETE_FAILED', status: response.status },
      })
    },
  },
}
