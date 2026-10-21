import { getOriginalFetch, getK8sServer } from '@/gateway/auth'
import { log } from '@/shared/utils'
import {
  type ResolverContext,
  getHeader,
  rethrowGraphQLError,
  failedPage,
  upstreamFailure,
} from './common'
import {
  type BillingEnrichment,
  type MappedOrganization,
  type MappedProject,
  type RequestLoaders,
  type UpstreamOrganizationList,
  type UpstreamProjectList,
  getRequestLoaders,
  mapOrganization,
  mapProjectFull,
  organizationsURL,
} from './loaders'

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

type OrgEnrichment = {
  displayName: string
  businessName: string | null
}

function orgEnrichmentFromMapped(org: MappedOrganization): OrgEnrichment {
  return {
    displayName: org.displayName || org.name,
    businessName: org.contactInfo?.businessName ?? null,
  }
}

function attachOrganizationFields(
  projects: MappedProject[],
  orgs: Map<string, OrgEnrichment>
): MappedProject[] {
  return projects.map((project) => {
    const org = orgs.get(project.organizationName)
    return {
      ...project,
      organizationDisplayName: org?.displayName ?? project.organizationName,
      organizationBusinessName: org?.businessName ?? null,
    }
  })
}

/**
 * Resolves display/company names for unique owning organizations.
 *
 * The loader dedupes org names across every alias in the request, so ten
 * projects owned by three orgs cost three GETs rather than ten. Per-org
 * failures are swallowed so one inaccessible org never fails the list.
 */
async function resolveOrganizationFields(
  orgNames: string[],
  loaders: RequestLoaders
): Promise<Map<string, OrgEnrichment>> {
  const result = new Map<string, OrgEnrichment>()
  const unique = [...new Set(orgNames.filter(Boolean))]

  await Promise.all(
    unique.map(async (name) => {
      const { value } = await loaders.organization(name)
      if (value) result.set(name, orgEnrichmentFromMapped(value))
    })
  )

  return result
}

/**
 * Per owning-org: load billing bindings + accounts, then work out which
 * projects have an Active binding to an account with a default payment
 * method.
 *
 * The billing loader keys by project but fetches each org's binding list
 * once, so projects sharing an org share that fetch. Failures are swallowed
 * per project so a single inaccessible billing namespace never fails the
 * whole list. Only depends on each project's `organizationName`, not on org
 * display/company enrichment, so it can run concurrently with
 * {@link resolveOrganizationFields}.
 */
async function resolveBillingFields(
  projects: MappedProject[],
  loaders: RequestLoaders
): Promise<Map<string, BillingEnrichment>> {
  const billingByProject = new Map<string, BillingEnrichment>()

  await Promise.all(
    projects.map(async (project) => {
      if (!project.organizationName) return
      const { value } = await loaders.billing(project.name, project.organizationName)
      if (value) billingByProject.set(project.name, value)
    })
  )

  return billingByProject
}

/**
 * Org display/company + billing payment status for a project list page.
 *
 * The two enrichment stages read disjoint upstream data (org display/company
 * info vs. billing bindings/accounts) and neither depends on the other's
 * result, so they run concurrently instead of one after the other.
 */
async function enrichProjects(
  projects: MappedProject[],
  loaders: RequestLoaders
): Promise<MappedProject[]> {
  const [orgs, billingByProject] = await Promise.all([
    resolveOrganizationFields(
      projects.map((item) => item.organizationName),
      loaders
    ),
    resolveBillingFields(projects, loaders),
  ])

  return attachOrganizationFields(projects, orgs).map((project) => {
    const billing = billingByProject.get(project.name)
    return {
      ...project,
      hasActiveBillingAccount: billing?.hasActiveBillingAccount ?? false,
      billingAccountName: billing?.billingAccountName ?? null,
    }
  })
}

function organizationMatchesSearch(org: MappedOrganization, search: string): boolean {
  const q = search.toLowerCase()
  return (
    org.name.toLowerCase().includes(q) ||
    org.displayName.toLowerCase().includes(q) ||
    (org.contactInfo?.businessName?.toLowerCase().includes(q) ?? false) ||
    (org.contactInfo?.email?.toLowerCase().includes(q) ?? false) ||
    (org.contactInfo?.name?.toLowerCase().includes(q) ?? false)
  )
}

/** Upstream page size while walking for substring search. */
const ORG_SEARCH_PAGE_SIZE = 100
/** Cap how many upstream pages a single search walks. */
const ORG_SEARCH_MAX_PAGES = 20

/**
 * Substring search across name / displayName / company / contact.
 * Walks upstream pages until `limit` matches or the page budget is exhausted.
 */
async function searchOrganizations(
  args: { limit?: number; cursor?: string; search: string },
  headers: Record<string, string>
): Promise<{ items: MappedOrganization[]; continueToken: string | null }> {
  const limit = args.limit ?? 50
  const matches: MappedOrganization[] = []
  let cursor = args.cursor
  let nextContinue: string | null = null

  for (let page = 0; page < ORG_SEARCH_MAX_PAGES && matches.length < limit; page++) {
    const url = organizationsURL({ limit: ORG_SEARCH_PAGE_SIZE, cursor })
    const r = await getOriginalFetch()(url, { headers })
    if (!r.ok) {
      log.warn('milo organizations search fetch failed', { status: r.status, url })
      failedPage(r, url)
    }
    const body = (await r.json()) as UpstreamOrganizationList
    for (const raw of body.items ?? []) {
      const org = mapOrganization(raw)
      if (!organizationMatchesSearch(org, args.search)) continue
      matches.push(org)
      if (matches.length >= limit) break
    }
    cursor = body.metadata?.continue ?? undefined
    nextContinue = cursor ?? null
    if (!cursor) {
      nextContinue = null
      break
    }
  }

  return {
    items: matches.slice(0, limit),
    // Only expose a continue token when we filled the page and more upstream
    // data may still exist — callers can pass it back to resume the walk.
    continueToken: matches.length >= limit ? nextContinue : null,
  }
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

export interface ConsumerProjectInfo {
  displayName: string
  organizationName: string
  organizationDisplayName: string
}

/**
 * Resolves the human-readable display name and owning organization for each
 * unique consumer project.
 *
 * Returns a name -> info map. Per-project failures (missing annotation, 403,
 * network) are swallowed so the project simply falls back to its raw name
 * later — a single inaccessible project never fails the whole query. The
 * project and org loaders dedupe aliases across the request, then unique
 * owning orgs are resolved via {@link resolveOrganizationFields}.
 */
async function resolveConsumerProjects(
  projectNames: string[],
  loaders: RequestLoaders
): Promise<Map<string, ConsumerProjectInfo>> {
  const projects = new Map<string, { displayName: string; organizationName: string }>()

  await Promise.all(
    projectNames.map(async (name) => {
      const { value: project } = await loaders.project(name)
      if (!project) return
      projects.set(name, {
        displayName: project.displayName,
        organizationName: project.organizationName,
      })
    })
  )

  const orgNames = [...projects.values()].map((p) => p.organizationName)
  const orgEnrichment = await resolveOrganizationFields(orgNames, loaders)

  const result = new Map<string, ConsumerProjectInfo>()
  for (const [name, info] of projects) {
    const org = orgEnrichment.get(info.organizationName)
    result.set(name, {
      displayName: info.displayName,
      organizationName: info.organizationName,
      organizationDisplayName: org?.displayName || info.organizationName,
    })
  }
  return result
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
  const headers = {
    ...(authorization ? { Authorization: authorization } : {}),
    Accept: 'application/json',
  }
  try {
    const url = orgProjectsURL(orgName, { limit: args.limit, cursor: args.cursor })
    const r = await getOriginalFetch()(url, { headers })
    if (!r.ok) {
      log.warn('milo organizationProjects fetch failed', { orgName, status: r.status })
      failedPage(r, url)
    }
    const body = (await r.json()) as UpstreamProjectList
    const items = (body.items ?? []).map(mapProjectFull)
    return {
      items: await enrichProjects(items, getRequestLoaders(context)),
      continueToken: body.metadata?.continue ?? null,
    }
  } catch (error) {
    rethrowGraphQLError(error)
    log.error('organizationProjects resolver failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    throw upstreamFailure(error, 'organizationProjects')
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
    rethrowGraphQLError(error)
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
      const headers = {
        ...(authorization ? { Authorization: authorization } : {}),
        Accept: 'application/json',
      }
      try {
        const search = args.search?.trim()
        if (search) {
          return await searchOrganizations(
            { limit: args.limit, cursor: args.cursor, search },
            headers
          )
        }

        const url = organizationsURL({
          limit: args.limit,
          cursor: args.cursor,
        })
        const r = await getOriginalFetch()(url, { headers })
        if (!r.ok) {
          log.warn('milo organizations fetch failed', { status: r.status, url })
          failedPage(r, url)
        }
        const body = (await r.json()) as UpstreamOrganizationList
        return {
          items: (body.items ?? []).map(mapOrganization),
          continueToken: body.metadata?.continue ?? null,
        }
      } catch (error) {
        rethrowGraphQLError(error)
        log.error('organizations resolver failed', {
          error: error instanceof Error ? error.message : String(error),
        })
        throw upstreamFailure(error, 'organizations')
      }
    },

    organization: async (_root: unknown, args: { name: string }, context: ResolverContext) => {
      try {
        const { value, error } = await getRequestLoaders(context).organization(args.name)
        if (error !== undefined) throw error
        return value
      } catch (error) {
        rethrowGraphQLError(error)
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
      const headers = {
        ...(authorization ? { Authorization: authorization } : {}),
        Accept: 'application/json',
      }
      try {
        const url = projectsListURL({ limit: args.limit, cursor: args.cursor, search: args.search })
        const r = await getOriginalFetch()(url, { headers })
        if (!r.ok) {
          log.warn('milo projects fetch failed', { status: r.status, url })
          failedPage(r, url)
        }
        const body = (await r.json()) as UpstreamProjectList
        const items = (body.items ?? []).map(mapProjectFull)
        return {
          items: await enrichProjects(items, getRequestLoaders(context)),
          continueToken: body.metadata?.continue ?? null,
        }
      } catch (error) {
        rethrowGraphQLError(error)
        log.error('projects resolver failed', {
          error: error instanceof Error ? error.message : String(error),
        })
        throw upstreamFailure(error, 'projects')
      }
    },

    project: async (_root: unknown, args: { name: string }, context: ResolverContext) => {
      const loaders = getRequestLoaders(context)
      try {
        const { value: project, error } = await loaders.project(args.name)
        if (error !== undefined) throw error
        if (!project) return null
        const [enriched] = await enrichProjects([project], loaders)
        return enriched
      } catch (error) {
        rethrowGraphQLError(error)
        log.error('project resolver failed', {
          error: error instanceof Error ? error.message : String(error),
        })
        return null
      }
    },

    serviceConsumers: async (
      _root: unknown,
      args: { producerProject: string; serviceNames?: string[] | null },
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
        // Every service can share one producer project, so filter to the
        // requested services before enriching — otherwise each call looks up
        // the project behind every consumer of every service.
        const serviceNames = args.serviceNames?.length ? new Set(args.serviceNames) : null
        const consumers = (body.items ?? []).filter(
          (c) => !serviceNames || serviceNames.has(c.spec?.serviceRef?.name ?? '')
        )

        const projectNames = [
          ...new Set(
            consumers
              .map((c) => c.spec?.consumerProjectRef?.name)
              .filter((name): name is string => !!name)
          ),
        ]
        const projectInfo = await resolveConsumerProjects(projectNames, getRequestLoaders(context))

        return consumers.map((consumer) => {
          const projectName = consumer.spec?.consumerProjectRef?.name ?? ''
          const info = projectInfo.get(projectName)
          return {
            name: consumer.metadata?.name ?? '',
            serviceName: consumer.spec?.serviceRef?.name ?? null,
            phase: consumer.status?.phase ?? null,
            approvalDecision: consumer.spec?.approval?.decision ?? null,
            approvalMessage: consumer.spec?.approval?.message ?? null,
            requestedAt: consumer.metadata?.creationTimestamp ?? null,
            consumerProject: {
              name: projectName,
              displayName: info?.displayName || projectName,
              organizationName: info?.organizationName ?? '',
              organizationDisplayName:
                info?.organizationDisplayName || info?.organizationName || '',
            },
          }
        })
      } catch (error) {
        rethrowGraphQLError(error)
        log.error('ServiceConsumers resolver failed', {
          error: error instanceof Error ? error.message : String(error),
        })
        return []
      }
    },
  },
}
