import { getOriginalFetch, getK8sServer } from '@/gateway/auth'
import { log } from '@/shared/utils'
import {
  type ResolverContext,
  getHeader,
  DESCRIPTION_ANNOTATION,
  DISPLAY_NAME_ANNOTATION,
} from './common'

interface UpstreamOrganization {
  metadata?: {
    name?: string
    creationTimestamp?: string
    annotations?: Record<string, string>
  }
  spec?: {
    type?: string
    contactInfo?: {
      businessName?: string
      name?: string
      email?: string
    }
  }
  status?: {
    conditions?: Array<{ type?: string; status?: string; reason?: string; message?: string }>
  }
}

interface UpstreamOrganizationList {
  items?: UpstreamOrganization[]
  metadata?: { continue?: string }
}

interface UpstreamProjectFull {
  metadata?: {
    name?: string
    creationTimestamp?: string
    annotations?: Record<string, string>
  }
  spec?: { ownerRef?: { name?: string; kind?: string } }
  status?: { conditions?: Array<{ type?: string; status?: string }> }
}

interface UpstreamProjectList {
  items?: UpstreamProjectFull[]
  metadata?: { continue?: string }
}

interface UpstreamOrganizationMembership {
  metadata?: { name?: string; creationTimestamp?: string }
  spec?: { userRef?: { name?: string }; roles?: Array<{ name: string; namespace?: string }> }
  status?: {
    user?: {
      givenName?: string
      familyName?: string
      email?: string
      avatarUrl?: string
    }
  }
}

interface UpstreamOrganizationMembershipList {
  items?: UpstreamOrganizationMembership[]
}

interface UpstreamUserInvitation {
  metadata?: { name?: string; creationTimestamp?: string }
  spec?: {
    givenName?: string
    familyName?: string
    email?: string
    roles?: Array<{ name: string; namespace?: string }>
    state?: string
  }
}

interface UpstreamUserInvitationList {
  items?: UpstreamUserInvitation[]
}

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

export interface MappedOrgContactInfo {
  businessName: string | null
  name: string | null
  email: string | null
}

export interface MappedOrganization {
  name: string
  displayName: string
  type: string
  createdAt: string | null
  state: string | null
  contactInfo: MappedOrgContactInfo | null
  onboardingComplete: boolean
  onboardingReason: string | null
  onboardingMessage: string | null
}

export interface MappedProject {
  name: string
  displayName: string
  organizationName: string
  createdAt: string | null
  state: string | null
}

function mapOrganization(raw: UpstreamOrganization): MappedOrganization {
  const annotations = raw.metadata?.annotations ?? {}
  const displayName = annotations[DISPLAY_NAME_ANNOTATION] || raw.metadata?.name || ''
  const readyCondition = raw.status?.conditions?.find((c) => c.type === 'Ready')
  const onboardingCondition = raw.status?.conditions?.find((c) => c.type === 'OnboardingComplete')
  const contact = raw.spec?.contactInfo
  return {
    name: raw.metadata?.name ?? '',
    displayName,
    type: raw.spec?.type ?? '',
    createdAt: raw.metadata?.creationTimestamp ?? null,
    state: readyCondition?.status ?? null,
    contactInfo: contact
      ? {
          businessName: contact.businessName?.trim() || null,
          name: contact.name ?? null,
          email: contact.email ?? null,
        }
      : null,
    onboardingComplete: onboardingCondition?.status === 'True',
    onboardingReason: onboardingCondition?.reason ?? null,
    onboardingMessage: onboardingCondition?.message ?? null,
  }
}

function mapProjectFull(raw: UpstreamProjectFull): MappedProject {
  const annotations = raw.metadata?.annotations ?? {}
  const displayName =
    annotations[DISPLAY_NAME_ANNOTATION] ||
    annotations[DESCRIPTION_ANNOTATION] ||
    raw.metadata?.name ||
    ''
  const readyCondition = raw.status?.conditions?.find((c) => c.type === 'Ready')
  return {
    name: raw.metadata?.name ?? '',
    displayName,
    organizationName: raw.spec?.ownerRef?.name ?? '',
    createdAt: raw.metadata?.creationTimestamp ?? null,
    state: readyCondition?.status ?? null,
  }
}

function organizationsURL(
  params: { name?: string; limit?: number; cursor?: string; search?: string } = {}
) {
  const server = getK8sServer()
  const base = `${server}/apis/resourcemanager.miloapis.com/v1alpha1/organizations`
  if (params.name) return `${base}/${encodeURIComponent(params.name)}`
  const query = new URLSearchParams()
  if (params.limit) query.set('limit', String(params.limit))
  if (params.cursor) query.set('continue', params.cursor)
  if (params.search) query.set('fieldSelector', `metadata.name=${params.search}`)
  const qs = query.toString()
  return qs ? `${base}?${qs}` : base
}

function orgProjectsURL(orgName: string, params: { limit?: number; cursor?: string } = {}) {
  const server = getK8sServer()
  const base =
    `${server}/apis/resourcemanager.miloapis.com/v1alpha1` +
    `/organizations/${encodeURIComponent(orgName)}/control-plane` +
    `/apis/resourcemanager.miloapis.com/v1alpha1/projects`
  const query = new URLSearchParams()
  if (params.limit) query.set('limit', String(params.limit))
  if (params.cursor) query.set('continue', params.cursor)
  const qs = query.toString()
  return qs ? `${base}?${qs}` : base
}

function orgMembershipsURL(orgName: string) {
  const server = getK8sServer()
  return (
    `${server}/apis/resourcemanager.miloapis.com/v1alpha1` +
    `/namespaces/organization-${encodeURIComponent(orgName)}/organizationmemberships`
  )
}

function orgInvitationsURL(orgName: string) {
  const server = getK8sServer()
  return (
    `${server}/apis/iam.miloapis.com/v1alpha1` +
    `/namespaces/organization-${encodeURIComponent(orgName)}/userinvitations`
  )
}

function projectsListURL(params: { limit?: number; cursor?: string; search?: string } = {}) {
  const server = getK8sServer()
  const base = `${server}/apis/resourcemanager.miloapis.com/v1alpha1/projects`
  const query = new URLSearchParams()
  if (params.limit) query.set('limit', String(params.limit))
  if (params.cursor) query.set('continue', params.cursor)
  if (params.search) query.set('fieldSelector', `metadata.name=${params.search}`)
  const qs = query.toString()
  return qs ? `${base}?${qs}` : base
}

// The Project object itself is read at the core resourcemanager API (no
// control-plane prefix) — that's where its annotations live.
function projectURL(name: string) {
  const server = getK8sServer()
  return `${server}/apis/resourcemanager.miloapis.com/v1alpha1/projects/${encodeURIComponent(name)}`
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
        const displayName =
          project.metadata?.annotations?.[DISPLAY_NAME_ANNOTATION] ||
          project.metadata?.annotations?.[DESCRIPTION_ANNOTATION]
        if (displayName) displayNames.set(name, displayName)
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

type OrgMemberResult = {
  name: string
  givenName: string | null
  familyName: string | null
  email: string
  roles: string[]
  type: string
  invitationState: string | null
  createdAt: string | null
  userName: string | null
  avatarUrl: string | null
}

type ProjectListResult = {
  items: MappedProject[]
  continueToken: string | null
}

async function fetchOrgProjects(
  orgName: string,
  args: { limit?: number; cursor?: string },
  context: ResolverContext
): Promise<ProjectListResult> {
  const authorization = getHeader(context, 'authorization')
  try {
    const url = orgProjectsURL(orgName, { limit: args.limit, cursor: args.cursor })
    const r = await getOriginalFetch()(url, {
      headers: {
        ...(authorization ? { Authorization: authorization } : {}),
        Accept: 'application/json',
      },
    })
    if (!r.ok) {
      log.warn('milo organizationProjects fetch failed', { orgName, status: r.status })
      return { items: [], continueToken: null }
    }
    const body = (await r.json()) as UpstreamProjectList
    return {
      items: (body.items ?? []).map(mapProjectFull),
      continueToken: body.metadata?.continue ?? null,
    }
  } catch (error) {
    log.error('organizationProjects resolver failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return { items: [], continueToken: null }
  }
}

async function fetchOrgMembers(
  orgName: string,
  context: ResolverContext
): Promise<OrgMemberResult[]> {
  const authorization = getHeader(context, 'authorization')
  const headers = {
    ...(authorization ? { Authorization: authorization } : {}),
    Accept: 'application/json',
  }
  const fetchFn = getOriginalFetch()
  try {
    const [membershipsRes, invitationsRes] = await Promise.all([
      fetchFn(orgMembershipsURL(orgName), { headers }),
      fetchFn(orgInvitationsURL(orgName), { headers }),
    ])

    const result: OrgMemberResult[] = []

    if (membershipsRes.ok) {
      const body = (await membershipsRes.json()) as UpstreamOrganizationMembershipList
      for (const m of body.items ?? []) {
        result.push({
          name: m.metadata?.name ?? '',
          givenName: m.status?.user?.givenName ?? null,
          familyName: m.status?.user?.familyName ?? null,
          email: m.status?.user?.email ?? '',
          roles: (m.spec?.roles ?? []).map((r) => r.name),
          type: 'member',
          invitationState: null,
          createdAt: m.metadata?.creationTimestamp ?? null,
          userName: m.spec?.userRef?.name ?? null,
          avatarUrl: m.status?.user?.avatarUrl ?? null,
        })
      }
    } else {
      log.warn('milo orgMemberships fetch failed', { orgName, status: membershipsRes.status })
    }

    if (invitationsRes.ok) {
      const body = (await invitationsRes.json()) as UpstreamUserInvitationList
      for (const inv of body.items ?? []) {
        result.push({
          name: inv.metadata?.name ?? '',
          givenName: inv.spec?.givenName ?? null,
          familyName: inv.spec?.familyName ?? null,
          email: inv.spec?.email ?? '',
          roles: (inv.spec?.roles ?? []).map((r) => r.name),
          type: 'invitation',
          invitationState: inv.spec?.state ?? null,
          createdAt: inv.metadata?.creationTimestamp ?? null,
          userName: null,
          avatarUrl: null,
        })
      }
    } else {
      log.warn('milo orgInvitations fetch failed', { orgName, status: invitationsRes.status })
    }

    return result
  } catch (error) {
    log.error('organizationMembers resolver failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return []
  }
}

export const organizationsResolvers = {
  Organization: {
    members: (parent: { name: string }, _args: unknown, context: ResolverContext) =>
      fetchOrgMembers(parent.name, context),
    projects: (
      parent: { name: string },
      args: { limit?: number; cursor?: string },
      context: ResolverContext
    ) => fetchOrgProjects(parent.name, args, context),
  },

  Query: {
    organizations: async (
      _root: unknown,
      args: { limit?: number; cursor?: string; search?: string },
      context: ResolverContext
    ) => {
      const authorization = getHeader(context, 'authorization')
      try {
        const url = organizationsURL({
          limit: args.limit,
          cursor: args.cursor,
          search: args.search,
        })
        const r = await getOriginalFetch()(url, {
          headers: {
            ...(authorization ? { Authorization: authorization } : {}),
            Accept: 'application/json',
          },
        })
        if (!r.ok) {
          log.warn('milo organizations fetch failed', { status: r.status, url })
          return { items: [], continueToken: null }
        }
        const body = (await r.json()) as UpstreamOrganizationList
        return {
          items: (body.items ?? []).map(mapOrganization),
          continueToken: body.metadata?.continue ?? null,
        }
      } catch (error) {
        log.error('organizations resolver failed', {
          error: error instanceof Error ? error.message : String(error),
        })
        return { items: [], continueToken: null }
      }
    },

    organization: async (_root: unknown, args: { name: string }, context: ResolverContext) => {
      const authorization = getHeader(context, 'authorization')
      try {
        const url = organizationsURL({ name: args.name })
        const r = await getOriginalFetch()(url, {
          headers: {
            ...(authorization ? { Authorization: authorization } : {}),
            Accept: 'application/json',
          },
        })
        if (!r.ok) {
          log.warn('milo organization fetch failed', { name: args.name, status: r.status })
          return null
        }
        return mapOrganization((await r.json()) as UpstreamOrganization)
      } catch (error) {
        log.error('organization resolver failed', {
          error: error instanceof Error ? error.message : String(error),
        })
        return null
      }
    },

    organizationProjects: (
      _root: unknown,
      args: { orgName: string; limit?: number; cursor?: string },
      context: ResolverContext
    ) => fetchOrgProjects(args.orgName, { limit: args.limit, cursor: args.cursor }, context),

    organizationMembers: (_root: unknown, args: { orgName: string }, context: ResolverContext) =>
      fetchOrgMembers(args.orgName, context),

    projects: async (
      _root: unknown,
      args: { limit?: number; cursor?: string; search?: string },
      context: ResolverContext
    ) => {
      const authorization = getHeader(context, 'authorization')
      try {
        const url = projectsListURL({ limit: args.limit, cursor: args.cursor, search: args.search })
        const r = await getOriginalFetch()(url, {
          headers: {
            ...(authorization ? { Authorization: authorization } : {}),
            Accept: 'application/json',
          },
        })
        if (!r.ok) {
          log.warn('milo projects fetch failed', { status: r.status, url })
          return { items: [], continueToken: null }
        }
        const body = (await r.json()) as UpstreamProjectList
        return {
          items: (body.items ?? []).map(mapProjectFull),
          continueToken: body.metadata?.continue ?? null,
        }
      } catch (error) {
        log.error('projects resolver failed', {
          error: error instanceof Error ? error.message : String(error),
        })
        return { items: [], continueToken: null }
      }
    },

    project: async (_root: unknown, args: { name: string }, context: ResolverContext) => {
      const authorization = getHeader(context, 'authorization')
      try {
        const r = await getOriginalFetch()(projectURL(args.name), {
          headers: {
            ...(authorization ? { Authorization: authorization } : {}),
            Accept: 'application/json',
          },
        })
        if (!r.ok) {
          log.warn('milo project fetch failed', { name: args.name, status: r.status })
          return null
        }
        return mapProjectFull((await r.json()) as UpstreamProjectFull)
      } catch (error) {
        log.error('project resolver failed', {
          error: error instanceof Error ? error.message : String(error),
        })
        return null
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
}
