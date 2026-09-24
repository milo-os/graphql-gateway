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
    platformAccess?: string
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

interface UpstreamFraudEvaluation {
  spec?: { userRef?: { name?: string } }
  status?: {
    compositeScore?: string
    decision?: string
    lastEvaluationTime?: string
  }
}

interface UpstreamFraudEvaluationList {
  items?: UpstreamFraudEvaluation[]
}

function fraudEvaluationsURL() {
  return `${getK8sServer()}/apis/fraud.miloapis.com/v1alpha1/fraudevaluations`
}

type FraudInfo = {
  fraudScore: string | null
  fraudDecision: string | null
  fraudEvaluatedAt: string | null
}

/** Lists FraudEvaluations once and returns the newest one per userRef.name. */
async function fetchLatestFraudByUser(headers: Record<string, string>): Promise<Map<string, FraudInfo>> {
  const byUser = new Map<string, FraudInfo>()
  try {
    const r = await getOriginalFetch()(fraudEvaluationsURL(), { headers })
    if (!r.ok) {
      log.warn('milo fraudEvaluations fetch failed', { status: r.status })
      return byUser
    }
    const body = (await r.json()) as UpstreamFraudEvaluationList
    // Evaluations repeat over time; keep the newest per user. Kubernetes
    // timestamps are ISO 8601, so lexicographic compare is chronological.
    const latest = new Map<string, UpstreamFraudEvaluation>()
    for (const evaluation of body.items ?? []) {
      const userName = evaluation.spec?.userRef?.name
      if (!userName) continue
      const current = latest.get(userName)
      const t = evaluation.status?.lastEvaluationTime ?? ''
      const currentT = current?.status?.lastEvaluationTime ?? ''
      if (!current || t > currentT) latest.set(userName, evaluation)
    }
    for (const [userName, evaluation] of latest) {
      byUser.set(userName, {
        fraudScore: evaluation.status?.compositeScore ?? null,
        fraudDecision: evaluation.status?.decision ?? null,
        fraudEvaluatedAt: evaluation.status?.lastEvaluationTime ?? null,
      })
    }
  } catch (error) {
    log.warn('fetchLatestFraudByUser failed', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
  return byUser
}

function usersListURL(params: { limit?: number; cursor?: string; fieldSelector?: string }) {
  const query = new URLSearchParams()
  if (params.limit) query.set('limit', String(params.limit))
  if (params.cursor) query.set('continue', params.cursor)
  if (params.fieldSelector) query.set('fieldSelector', params.fieldSelector)
  const qs = query.toString()
  const base = `${getK8sServer()}/apis/iam.miloapis.com/v1alpha1/users`
  return qs ? `${base}?${qs}` : base
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
    platformAccess: raw.status?.platformAccess ?? null,
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

    users: async (
      _root: unknown,
      args: { limit?: number; cursor?: string; search?: string; platformAccess?: string },
      context: ResolverContext
    ) => {
      const authorization = getHeader(context, 'authorization')
      const headers = {
        ...(authorization ? { Authorization: authorization } : {}),
        Accept: 'application/json',
      }
      try {
        const selectors: string[] = []
        const email = args.search?.trim()
        if (email) selectors.push(`spec.email=${email}`)
        if (args.platformAccess) selectors.push(`status.platformAccess=${args.platformAccess}`)

        // Fetch the user page and the fraud evaluations concurrently, then join.
        const [usersRes, fraudByUser] = await Promise.all([
          getOriginalFetch()(
            usersListURL({
              limit: args.limit,
              cursor: args.cursor,
              fieldSelector: selectors.length ? selectors.join(',') : undefined,
            }),
            { headers }
          ),
          fetchLatestFraudByUser(headers),
        ])
        if (!usersRes.ok) {
          log.warn('milo users fetch failed', { status: usersRes.status })
          return { items: [], continueToken: null }
        }
        const body = (await usersRes.json()) as {
          items?: UpstreamUser[]
          metadata?: { continue?: string }
        }
        return {
          items: (body.items ?? []).map((u) => {
            const mapped = mapUser(u)
            const fraud = fraudByUser.get(mapped.name)
            return {
              ...mapped,
              fraudScore: fraud?.fraudScore ?? null,
              fraudDecision: fraud?.fraudDecision ?? null,
              fraudEvaluatedAt: fraud?.fraudEvaluatedAt ?? null,
            }
          }),
          continueToken: body.metadata?.continue ?? null,
        }
      } catch (error) {
        log.error('users resolver failed', {
          error: error instanceof Error ? error.message : String(error),
        })
        return { items: [], continueToken: null }
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
