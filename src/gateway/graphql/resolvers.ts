import { parseUserAgent } from '@/gateway/services/user-agent'
import { lookupIp } from '@/gateway/services/geolocation'
import { getK8sServer } from '@/gateway/auth'
import { log } from '@/shared/utils'
import GraphQLJSON from './json-scalar'

interface ResolverContext {
  headers: Record<string, string>
}

interface UpstreamSession {
  id?: string
  ipAddress?: string
  userAgent?: string
  [key: string]: unknown
}

function enrichSession(session: UpstreamSession) {
  const ipAddress = session.ipAddress ?? null
  const rawUserAgent = session.userAgent ?? null

  return {
    id: session.id ?? 'unknown',
    userAgent: rawUserAgent ? parseUserAgent(rawUserAgent) : null,
    location: ipAddress ? lookupIp(ipAddress) : null,
    ipAddress,
    raw: session,
  }
}

export const additionalResolvers = {
  JSON: GraphQLJSON,

  Query: {
    parseUserAgent: (_root: unknown, args: { userAgent: string }) => {
      return parseUserAgent(args.userAgent)
    },

    sessions: async (_root: unknown, _args: unknown, context: ResolverContext) => {
      try {
        const server = getK8sServer()
        const endpointPrefix = context.headers['x-resource-endpoint-prefix'] || ''
        const authorization = context.headers['authorization'] || ''

        // TODO: adjust this path to match milo session list endpoint
        const sessionsUrl = `${server}${endpointPrefix}/apis/identity.miloapis.com/v1alpha1/sessions/{name}`

        const response = await fetch(sessionsUrl, {
          headers: {
            Authorization: authorization,
            Accept: 'application/json',
          },
        })

        if (!response.ok) {
          log.warn('Failed to fetch sessions from upstream', {
            status: response.status,
          })
          return []
        }

        const data = (await response.json()) as Record<string, unknown>

        const sessions = (Array.isArray(data.sessions) ? data.sessions : Array.isArray(data.items) ? data.items : []) as UpstreamSession[]

        return sessions.map(enrichSession)
      } catch (error) {
        log.error('Sessions resolver failed', {
          error: error instanceof Error ? error.message : String(error),
        })
        return []
      }
    },
  },
}
