import { getOriginalFetch, getK8sServer } from '@/gateway/auth'
import { log } from '@/shared/utils'
import { type ResolverContext, getHeader, DESCRIPTION_ANNOTATION } from './common'

interface UpstreamContactGroupMembership {
  metadata?: { name?: string; creationTimestamp?: string }
  spec?: {
    contactRef?: { name?: string; namespace?: string }
    contactGroupRef?: { name?: string; namespace?: string }
  }
}

interface UpstreamCondition {
  type?: string
  status?: string
  reason?: string
  message?: string
  lastTransitionTime?: string
  observedGeneration?: number
}

interface UpstreamContactGroupMembershipList {
  items?: UpstreamContactGroupMembership[]
  metadata?: { continue?: string }
}

interface UpstreamContact {
  metadata?: { name?: string; namespace?: string; annotations?: Record<string, string> }
  spec?: { email?: string; givenName?: string; familyName?: string }
}

interface UpstreamContactGroup {
  metadata?: { name?: string; namespace?: string; annotations?: Record<string, string> }
  spec?: { displayName?: string; visibility?: string }
  status?: { conditions?: UpstreamCondition[] }
}

function mapContact(contact: UpstreamContact) {
  return {
    name: contact.metadata?.name ?? '',
    namespace: contact.metadata?.namespace ?? '',
    email: contact.spec?.email ?? null,
    givenName: contact.spec?.givenName ?? null,
    familyName: contact.spec?.familyName ?? null,
    displayName: contact.metadata?.annotations?.[DESCRIPTION_ANNOTATION] ?? null,
  }
}

function mapContactGroup(group: UpstreamContactGroup) {
  return {
    name: group.metadata?.name ?? '',
    namespace: group.metadata?.namespace ?? '',
    displayName: group.spec?.displayName ?? null,
    visibility: group.spec?.visibility ?? null,
    status: group.status
      ? {
          conditions: (group.status.conditions ?? []).map((c) => ({
            type: c.type ?? '',
            status: c.status ?? '',
            reason: c.reason ?? null,
            message: c.message ?? null,
            lastTransitionTime: c.lastTransitionTime ?? null,
            observedGeneration: c.observedGeneration ?? null,
          })),
        }
      : null,
  }
}

/**
 * Builds the ContactGroupMembership list URL. When no namespace is given we list
 * across ALL namespaces (the cluster-scoped path), so memberships that live
 * outside `default` are included — callers filter by `spec.contactRef.name` /
 * `spec.contactGroupRef.name` and expect every match regardless of the
 * membership's own namespace. An explicit `namespace` still scopes the list.
 */
export function buildMembershipsListUrl(
  server: string,
  args: { namespace?: string; fieldSelector?: string; limit?: number; cursor?: string }
): string {
  const params = new URLSearchParams()
  if (args.fieldSelector) params.set('fieldSelector', args.fieldSelector)
  if (args.limit != null) params.set('limit', String(args.limit))
  if (args.cursor) params.set('continue', args.cursor)
  const paramStr = params.toString()
  const base = args.namespace
    ? `${server}/apis/notification.miloapis.com/v1alpha1/namespaces/${encodeURIComponent(args.namespace)}/contactgroupmemberships`
    : `${server}/apis/notification.miloapis.com/v1alpha1/contactgroupmemberships`
  return paramStr ? `${base}?${paramStr}` : base
}

async function fetchMemberships(
  args: { namespace?: string; fieldSelector?: string; limit?: number; cursor?: string },
  context: ResolverContext
) {
  const authorization = getHeader(context, 'authorization')
  const fetchFn = getOriginalFetch()
  const headers = {
    ...(authorization ? { Authorization: authorization } : {}),
    Accept: 'application/json',
  }
  const server = getK8sServer()
  const url = buildMembershipsListUrl(server, args)

  const response = await fetchFn(url, { headers })
  if (!response.ok) {
    log.warn('milo contactgroupmemberships fetch failed', { status: response.status, url, hasAuthorization: !!authorization })
    return { headers, memberships: [], continueToken: null }
  }
  const body = (await response.json()) as UpstreamContactGroupMembershipList
  return { headers, memberships: body.items ?? [], continueToken: body.metadata?.continue ?? null }
}

export const contactsResolvers = {
  Query: {
    contactGroupMembershipsWithContacts: async (
      _root: unknown,
      args: { namespace?: string; fieldSelector?: string; limit?: number; cursor?: string },
      context: ResolverContext
    ) => {
      try {
        const { headers, memberships, continueToken } = await fetchMemberships(args, context)
        const server = getK8sServer()
        const uniqueContacts = new Map<string, { name: string; namespace: string }>()
        for (const m of memberships) {
          const ref = m.spec?.contactRef
          if (ref?.name && ref.namespace) {
            uniqueContacts.set(`${ref.namespace}/${ref.name}`, { name: ref.name, namespace: ref.namespace })
          }
        }
        const contactMap = new Map<string, ReturnType<typeof mapContact>>()
        const fetchFn = getOriginalFetch()
        await Promise.all(
          Array.from(uniqueContacts.values()).map(async ({ name, namespace }) => {
            try {
              const url = `${server}/apis/notification.miloapis.com/v1alpha1/namespaces/${encodeURIComponent(namespace)}/contacts/${encodeURIComponent(name)}`
              const r = await fetchFn(url, { headers })
              if (!r.ok) return
              contactMap.set(`${namespace}/${name}`, mapContact((await r.json()) as UpstreamContact))
            } catch (error) {
              log.warn('milo contact fetch threw', { name, namespace, error: error instanceof Error ? error.message : String(error) })
            }
          })
        )
        return {
          continue: continueToken,
          items: memberships.map((m) => {
            const ref = m.spec?.contactRef
            const key = ref?.namespace && ref.name ? `${ref.namespace}/${ref.name}` : ''
            return {
              name: m.metadata?.name ?? '',
              contactRef: { name: ref?.name ?? '', namespace: ref?.namespace ?? '' },
              contact: key ? (contactMap.get(key) ?? null) : null,
            }
          }),
        }
      } catch (error) {
        log.error('contactGroupMembershipsWithContacts resolver failed', { error: error instanceof Error ? error.message : String(error) })
        return { items: [] }
      }
    },

    contactMembershipsWithGroups: async (
      _root: unknown,
      args: { namespace?: string; fieldSelector?: string; limit?: number; cursor?: string },
      context: ResolverContext
    ) => {
      try {
        const { headers, memberships, continueToken } = await fetchMemberships(args, context)
        const server = getK8sServer()
        const uniqueGroups = new Map<string, { name: string; namespace: string }>()
        for (const m of memberships) {
          const ref = m.spec?.contactGroupRef
          if (ref?.name && ref.namespace) {
            uniqueGroups.set(`${ref.namespace}/${ref.name}`, { name: ref.name, namespace: ref.namespace })
          }
        }
        const groupMap = new Map<string, ReturnType<typeof mapContactGroup>>()
        const fetchFn = getOriginalFetch()
        await Promise.all(
          Array.from(uniqueGroups.values()).map(async ({ name, namespace }) => {
            try {
              const url = `${server}/apis/notification.miloapis.com/v1alpha1/namespaces/${encodeURIComponent(namespace)}/contactgroups/${encodeURIComponent(name)}`
              const r = await fetchFn(url, { headers })
              if (!r.ok) return
              groupMap.set(`${namespace}/${name}`, mapContactGroup((await r.json()) as UpstreamContactGroup))
            } catch (error) {
              log.warn('milo contactgroup fetch threw', { name, namespace, error: error instanceof Error ? error.message : String(error) })
            }
          })
        )
        return {
          continue: continueToken,
          items: memberships.map((m) => {
            const ref = m.spec?.contactGroupRef
            const key = ref?.namespace && ref.name ? `${ref.namespace}/${ref.name}` : ''
            return {
              name: m.metadata?.name ?? '',
              creationTimestamp: m.metadata?.creationTimestamp ?? null,
              contactGroupRef: { name: ref?.name ?? '', namespace: ref?.namespace ?? '' },
              contactGroup: key ? (groupMap.get(key) ?? null) : null,
            }
          }),
        }
      } catch (error) {
        log.error('contactMembershipsWithGroups resolver failed', { error: error instanceof Error ? error.message : String(error) })
        return { items: [] }
      }
    },
  },
}
