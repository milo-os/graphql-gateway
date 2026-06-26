import { GraphQLError } from 'graphql'
import { getOriginalFetch, getK8sServer } from '@/gateway/auth'
import { log } from '@/shared/utils'
import { type ResolverContext, getHeader } from './common'

interface UpstreamUser {
  metadata?: {
    name?: string
    uid?: string
    resourceVersion?: string
    creationTimestamp?: string
    annotations?: Record<string, string>
  }
  spec?: { email?: string; givenName?: string; familyName?: string }
  status?: {
    registrationApproval?: string
    state?: string
    avatarUrl?: string
    lastLoginProvider?: string
  }
}

interface UpstreamUserIdentity {
  metadata?: { name?: string; creationTimestamp?: string }
  status?: { userUID?: string; providerID?: string; providerName?: string; username?: string }
}

interface UpstreamUserIdentityList {
  items?: UpstreamUserIdentity[]
}

const NAME_REVIEW_ANNOTATION = 'iam.miloapis.com/name-review-required'
const USER_SUMMARIES_MAX = 100

function mapUser(raw: UpstreamUser) {
  const annotations = raw.metadata?.annotations ?? {}
  const newsletterRaw = annotations['preferences/newsletter']
  return {
    name: raw.metadata?.name ?? '',
    uid: raw.metadata?.uid ?? null,
    resourceVersion: raw.metadata?.resourceVersion ?? null,
    email: raw.spec?.email ?? null,
    givenName: raw.spec?.givenName ?? null,
    familyName: raw.spec?.familyName ?? null,
    createdAt: raw.metadata?.creationTimestamp ?? null,
    theme: annotations['preferences/theme'] ?? null,
    timezone: annotations['preferences/timezone'] ?? null,
    newsletter: newsletterRaw != null ? newsletterRaw === 'true' : null,
    onboardedAt: annotations['onboarding/completedAt'] ?? null,
    registrationApproval: raw.status?.registrationApproval ?? null,
    state: raw.status?.state ?? null,
    avatarUrl: raw.status?.avatarUrl ?? null,
    lastLoginProvider: raw.status?.lastLoginProvider ?? null,
    nameReviewRequired: annotations[NAME_REVIEW_ANNOTATION] === 'true',
  }
}

function mapUserIdentity(raw: UpstreamUserIdentity) {
  return {
    name: raw.metadata?.name ?? '',
    createdAt: raw.metadata?.creationTimestamp ?? null,
    userUID: raw.status?.userUID ?? null,
    providerID: raw.status?.providerID ?? null,
    providerName: raw.status?.providerName ?? null,
    username: raw.status?.username ?? null,
  }
}

function userURL(id: string) {
  return `${getK8sServer()}/apis/iam.miloapis.com/v1alpha1/users/${encodeURIComponent(id)}`
}

function userIdentitiesURL(userID: string) {
  return (
    `${getK8sServer()}/apis/iam.miloapis.com/v1alpha1/users/${encodeURIComponent(userID)}` +
    `/control-plane/apis/identity.miloapis.com/v1alpha1/useridentities`
  )
}

export const usersResolvers = {
  Query: {
    me: async (_root: unknown, _args: unknown, context: ResolverContext) => {
      const authorization = getHeader(context, 'authorization')
      try {
        const r = await getOriginalFetch()(userURL('me'), {
          headers: { ...(authorization ? { Authorization: authorization } : {}), Accept: 'application/json' },
        })
        if (!r.ok) {
          log.warn('milo user me fetch failed', { status: r.status })
          return null
        }
        return mapUser((await r.json()) as UpstreamUser)
      } catch (error) {
        log.error('me resolver failed', { error: error instanceof Error ? error.message : String(error) })
        return null
      }
    },

    user: async (_root: unknown, args: { id: string }, context: ResolverContext) => {
      const authorization = getHeader(context, 'authorization')
      try {
        const r = await getOriginalFetch()(userURL(args.id), {
          headers: { ...(authorization ? { Authorization: authorization } : {}), Accept: 'application/json' },
        })
        if (!r.ok) {
          log.warn('milo user fetch failed', { id: args.id, status: r.status })
          return null
        }
        return mapUser((await r.json()) as UpstreamUser)
      } catch (error) {
        log.error('user resolver failed', { error: error instanceof Error ? error.message : String(error) })
        return null
      }
    },

    userSummaries: async (
      _root: unknown,
      args: { names: string[] },
      context: ResolverContext
    ) => {
      try {
        const authorization = getHeader(context, 'authorization')
        const fetchFn = getOriginalFetch()
        const headers = {
          ...(authorization ? { Authorization: authorization } : {}),
          Accept: 'application/json',
        }

        const server = getK8sServer()

        const names = args.names.slice(0, USER_SUMMARIES_MAX)
        if (args.names.length > USER_SUMMARIES_MAX) {
          log.warn('userSummaries truncated', { requested: args.names.length, limit: USER_SUMMARIES_MAX })
        }

        const results = await Promise.all(
          names.map(async (name) => {
            try {
              const url = `${server}/apis/iam.miloapis.com/v1alpha1/users/${encodeURIComponent(name)}`
              const r = await fetchFn(url, { headers })
              if (!r.ok) {
                log.warn('milo user fetch failed', { name, status: r.status })
                return null
              }
              const user = (await r.json()) as UpstreamUser
              return {
                name: user.metadata?.name ?? name,
                email: user.spec?.email ?? null,
                givenName: user.spec?.givenName ?? null,
                familyName: user.spec?.familyName ?? null,
              }
            } catch (error) {
              log.warn('milo user fetch threw', {
                name,
                error: error instanceof Error ? error.message : String(error),
              })
              return null
            }
          })
        )

        return results.filter((u): u is NonNullable<typeof u> => u !== null)
      } catch (error) {
        log.error('userSummaries resolver failed', {
          error: error instanceof Error ? error.message : String(error),
        })
        return []
      }
    },

    userIdentities: async (_root: unknown, args: { userID: string }, context: ResolverContext) => {
      const authorization = getHeader(context, 'authorization')
      try {
        const r = await getOriginalFetch()(userIdentitiesURL(args.userID), {
          headers: { ...(authorization ? { Authorization: authorization } : {}), Accept: 'application/json' },
        })
        if (!r.ok) {
          log.warn('milo userIdentities fetch failed', { userID: args.userID, status: r.status })
          return []
        }
        const body = (await r.json()) as UpstreamUserIdentityList
        return (body.items ?? []).map(mapUserIdentity)
      } catch (error) {
        log.error('userIdentities resolver failed', { error: error instanceof Error ? error.message : String(error) })
        return []
      }
    },
  },

  Mutation: {
    updateUser: async (
      _root: unknown,
      args: { id: string; input: { givenName?: string; familyName?: string; email?: string } },
      context: ResolverContext
    ) => {
      const authorization = getHeader(context, 'authorization')
      const body = {
        apiVersion: 'iam.miloapis.com/v1alpha1',
        kind: 'User',
        spec: {
          ...(args.input.givenName != null ? { givenName: args.input.givenName } : {}),
          ...(args.input.familyName != null ? { familyName: args.input.familyName } : {}),
          ...(args.input.email != null ? { email: args.input.email } : {}),
        },
      }
      const url = `${userURL(args.id)}?fieldManager=datum-cloud-portal`
      const r = await getOriginalFetch()(url, {
        method: 'PATCH',
        headers: {
          ...(authorization ? { Authorization: authorization } : {}),
          'Content-Type': 'application/merge-patch+json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
      })
      if (!r.ok) {
        const detail = await r.text().catch(() => '')
        log.warn('milo updateUser failed', { id: args.id, status: r.status, detail })
        throw new GraphQLError(`Failed to update user: ${r.status}`, {
          extensions: { code: 'USER_UPDATE_FAILED', status: r.status },
        })
      }
      return mapUser((await r.json()) as UpstreamUser)
    },

    updateUserPreferences: async (
      _root: unknown,
      args: {
        id: string
        input: { theme?: string; timezone?: string; newsletter?: boolean; onboardedAt?: string }
      },
      context: ResolverContext
    ) => {
      const authorization = getHeader(context, 'authorization')
      const annotations: Record<string, string> = {}
      if (args.input.theme != null) annotations['preferences/theme'] = args.input.theme
      if (args.input.timezone != null) annotations['preferences/timezone'] = args.input.timezone
      if (args.input.newsletter != null) annotations['preferences/newsletter'] = String(args.input.newsletter)
      if (args.input.onboardedAt != null) annotations['onboarding/completedAt'] = args.input.onboardedAt
      const body = {
        apiVersion: 'iam.miloapis.com/v1alpha1',
        kind: 'User',
        ...(Object.keys(annotations).length > 0 ? { metadata: { annotations } } : {}),
      }
      const url = `${userURL(args.id)}?fieldManager=datum-cloud-portal`
      const r = await getOriginalFetch()(url, {
        method: 'PATCH',
        headers: {
          ...(authorization ? { Authorization: authorization } : {}),
          'Content-Type': 'application/merge-patch+json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
      })
      if (!r.ok) {
        const detail = await r.text().catch(() => '')
        log.warn('milo updateUserPreferences failed', { id: args.id, status: r.status, detail })
        throw new GraphQLError(`Failed to update user preferences: ${r.status}`, {
          extensions: { code: 'USER_PREFERENCES_UPDATE_FAILED', status: r.status },
        })
      }
      return mapUser((await r.json()) as UpstreamUser)
    },

    deleteUser: async (_root: unknown, args: { id: string }, context: ResolverContext) => {
      const authorization = getHeader(context, 'authorization')
      const r = await getOriginalFetch()(userURL(args.id), {
        method: 'DELETE',
        headers: {
          ...(authorization ? { Authorization: authorization } : {}),
          Accept: 'application/json',
        },
      })
      if (!r.ok && r.status !== 404) {
        const detail = await r.text().catch(() => '')
        log.warn('milo deleteUser failed', { id: args.id, status: r.status, detail })
        throw new GraphQLError(`Failed to delete user: ${r.status}`, {
          extensions: { code: 'USER_DELETE_FAILED', status: r.status },
        })
      }
      return r.ok ? mapUser((await r.json()) as UpstreamUser) : null
    },
  },
}
