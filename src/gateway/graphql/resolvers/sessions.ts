import { GraphQLError } from 'graphql'
import { parseUserAgent } from '@/gateway/services/user-agent'
import { lookupIp } from '@/gateway/services/geolocation'
import { getK8sServer, getOriginalFetch } from '@/gateway/auth'
import { log } from '@/shared/utils'
import { type ResolverContext, getHeader } from './common'

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

export const sessionsResolvers = {
  Query: {
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
