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

const DESCRIPTION_ANNOTATION = 'kubernetes.io/description'
const PROJECT_DESCRIPTION_ANNOTATION = 'kubernetes.io/description'

interface UpstreamContactGroupMembership {
  metadata?: { name?: string }
  spec?: {
    contactRef?: { name?: string; namespace?: string }
    contactGroupRef?: { name?: string; namespace?: string }
  }
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
  spec?: { displayName?: string }
}

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
        const description = project.metadata?.annotations?.[DESCRIPTION_ANNOTATION]
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
  }
}

const USER_SUMMARIES_MAX = 100

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
  const namespace = encodeURIComponent(args.namespace ?? 'default')
  const params = new URLSearchParams()
  if (args.fieldSelector) params.set('fieldSelector', args.fieldSelector)
  if (args.limit != null) params.set('limit', String(args.limit))
  if (args.cursor) params.set('continue', args.cursor)
  const paramStr = params.toString()
  const url =
    `${server}/apis/notification.miloapis.com/v1alpha1/namespaces/${namespace}/contactgroupmemberships` +
    (paramStr ? `?${paramStr}` : '')

  const response = await fetchFn(url, { headers })
  if (!response.ok) {
    log.warn('milo contactgroupmemberships fetch failed', { status: response.status, url, hasAuthorization: !!authorization })
    return { headers, memberships: [], continueToken: null }
  }
  const body = (await response.json()) as UpstreamContactGroupMembershipList
  return { headers, memberships: body.items ?? [], continueToken: body.metadata?.continue ?? null }
}

// ============================================================================
// Organizations + Projects
// ============================================================================

interface UpstreamOrganization {
  metadata?: {
    name?: string
    creationTimestamp?: string
    annotations?: Record<string, string>
  }
  spec?: { type?: string }
  status?: { conditions?: Array<{ type?: string; status?: string }> }
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
  status?: { user?: { givenName?: string; familyName?: string; email?: string } }
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

// ─── Quota upstream types ─────────────────────────────────────────────────────

interface UpstreamAllowanceBucket {
  metadata?: { name?: string; namespace?: string }
  spec?: {
    resourceType?: string
    consumerRef?: { apiGroup?: string; kind?: string; name?: string }
  }
  status?: { allocated?: number; limit?: number; available?: number }
}

interface UpstreamAllowanceBucketList {
  items?: UpstreamAllowanceBucket[]
}

interface UpstreamResourceRegistration {
  metadata?: {
    name?: string
    annotations?: Record<string, string>
    labels?: Record<string, string>
  }
  spec?: { resourceType?: string; type?: string; description?: string }
}

interface UpstreamResourceRegistrationList {
  items?: UpstreamResourceRegistration[]
}

interface UpstreamResourceGrant {
  metadata?: {
    name?: string
    namespace?: string
    creationTimestamp?: string
    labels?: Record<string, string>
  }
  spec?: {
    allowances?: Array<{
      resourceType?: string
      buckets?: Array<{ amount?: number }>
    }>
  }
  status?: { conditions?: Array<{ type?: string; status?: string; message?: string }> }
}

interface UpstreamResourceGrantList {
  items?: UpstreamResourceGrant[]
}

// ─── Service-catalog resolution (mirrors staff-portal service-catalog.ts) ────

const QUOTA_SERVICE_DISPLAY_NAMES: Record<string, string> = {
  'core.miloapis.com': 'Platform Core',
  'notes.miloapis.com': 'Notes',
  'dns.networking.miloapis.com': 'DNS',
  'networking.datumapis.com': 'Networking',
  'resourcemanager.miloapis.com': 'Organization & Projects',
  'compute.datumapis.com': 'Compute',
  'billing.miloapis.com': 'Billing',
}

const QUOTA_RESOURCE_DISPLAY_NAMES: Record<string, string> = {
  'compute.datumapis.com/instances': 'Instances',
  'compute.datumapis.com/vcpus': 'vCPUs',
  'compute.datumapis.com/memory': 'Memory',
  'compute.datumapis.com/workloads': 'Workloads',
}

const QUOTA_RESOURCE_TYPE_BRIDGE: Record<string, string> = {
  'gateway.networking.k8s.io/gateways': 'networking.datumapis.com',
  'gateway.networking.k8s.io/httproutes': 'networking.datumapis.com',
  'gateway.networking.k8s.io/backendtlspolicies': 'networking.datumapis.com',
  'gateway.envoyproxy.io/securitypolicies': 'networking.datumapis.com',
  'gateway.envoyproxy.io/httproutefilters': 'networking.datumapis.com',
  'gateway.envoyproxy.io/backends': 'networking.datumapis.com',
  'gateway.envoyproxy.io/backendtrafficpolicies': 'networking.datumapis.com',
  'discovery.k8s.io/endpointslices': 'networking.datumapis.com',
  'networking.datumapis.com/httpproxies': 'networking.datumapis.com',
  'networking.datumapis.com/domains': 'networking.datumapis.com',
  'networking.datumapis.com/connectors': 'networking.datumapis.com',
  'networking.datumapis.com/connectoradvertisements': 'networking.datumapis.com',
  'networking.datumapis.com/trafficprotectionpolicies': 'networking.datumapis.com',
  'dns.networking.miloapis.com/dnszones': 'dns.networking.miloapis.com',
  'dns.networking.miloapis.com/dnsrecordsets': 'dns.networking.miloapis.com',
}

function quotaServiceDisplayName(owner: string | undefined, resourceType: string): string {
  const serviceName = owner ?? QUOTA_RESOURCE_TYPE_BRIDGE[resourceType]
  if (!serviceName) return 'Other'
  return QUOTA_SERVICE_DISPLAY_NAMES[serviceName] ?? 'Other'
}

function quotaResourceDisplayName(serverDisplayName: string | undefined, resourceType: string): string {
  return serverDisplayName ?? QUOTA_RESOURCE_DISPLAY_NAMES[resourceType] ?? resourceType
}

function buildRegistrationMap(
  list: UpstreamResourceRegistrationList
): Map<string, UpstreamResourceRegistration> {
  const map = new Map<string, UpstreamResourceRegistration>()
  for (const reg of list.items ?? []) {
    if (reg.spec?.resourceType) map.set(reg.spec.resourceType, reg)
  }
  return map
}

// ─── Quota URL helpers ────────────────────────────────────────────────────────

function resourceRegistrationsURL() {
  return `${getK8sServer()}/apis/quota.miloapis.com/v1alpha1/resourceregistrations`
}

function orgQuotaBucketsURL(orgName: string) {
  const base =
    `${getK8sServer()}/apis/resourcemanager.miloapis.com/v1alpha1` +
    `/organizations/${encodeURIComponent(orgName)}/control-plane` +
    `/apis/quota.miloapis.com/v1alpha1` +
    `/namespaces/organization-${encodeURIComponent(orgName)}/allowancebuckets`
  const qs = new URLSearchParams({
    fieldSelector: `spec.consumerRef.kind=Organization,spec.consumerRef.name=${orgName}`,
  })
  return `${base}?${qs}`
}

function projectQuotaBucketsURL(projectName: string) {
  const base =
    `${getK8sServer()}/apis/resourcemanager.miloapis.com/v1alpha1` +
    `/projects/${encodeURIComponent(projectName)}/control-plane` +
    `/apis/quota.miloapis.com/v1alpha1/namespaces/milo-system/allowancebuckets`
  const qs = new URLSearchParams({
    fieldSelector: `spec.consumerRef.kind=Project,spec.consumerRef.name=${projectName}`,
  })
  return `${base}?${qs}`
}

function orgQuotaGrantsURL(orgName: string) {
  const base =
    `${getK8sServer()}/apis/resourcemanager.miloapis.com/v1alpha1` +
    `/organizations/${encodeURIComponent(orgName)}/control-plane` +
    `/apis/quota.miloapis.com/v1alpha1` +
    `/namespaces/organization-${encodeURIComponent(orgName)}/resourcegrants`
  const qs = new URLSearchParams({
    fieldSelector: `spec.consumerRef.kind=Organization,spec.consumerRef.name=${orgName}`,
  })
  return `${base}?${qs}`
}

function projectQuotaGrantsURL(projectName: string) {
  const base =
    `${getK8sServer()}/apis/resourcemanager.miloapis.com/v1alpha1` +
    `/projects/${encodeURIComponent(projectName)}/control-plane` +
    `/apis/quota.miloapis.com/v1alpha1/namespaces/milo-system/resourcegrants`
  const qs = new URLSearchParams({
    fieldSelector: `spec.consumerRef.kind=Project,spec.consumerRef.name=${projectName}`,
  })
  return `${base}?${qs}`
}

function mapQuotaBuckets(
  bucketList: UpstreamAllowanceBucketList,
  regs: Map<string, UpstreamResourceRegistration>
) {
  return (bucketList.items ?? [])
    .filter((b) => {
      const reg = regs.get(b.spec?.resourceType ?? '')
      return String(reg?.spec?.type ?? '') !== 'Feature'
    })
    .map((b) => {
      const resourceType = b.spec?.resourceType ?? ''
      const reg = regs.get(resourceType)
      const annotations = reg?.metadata?.annotations ?? {}
      const labels = reg?.metadata?.labels ?? {}
      const owner = labels['services.miloapis.com/owner'] ?? labels['services.miloapis.com/service']
      return {
        name: b.metadata?.name ?? '',
        namespace: b.metadata?.namespace ?? '',
        resourceType,
        consumerKind: b.spec?.consumerRef?.kind ?? '',
        consumerName: b.spec?.consumerRef?.name ?? '',
        consumerApiGroup: b.spec?.consumerRef?.apiGroup ?? '',
        allocated: b.status?.allocated ?? 0,
        limit: b.status?.limit ?? 0,
        available: b.status?.available ?? 0,
        displayName: quotaResourceDisplayName(annotations['kubernetes.io/display-name'], resourceType),
        description: annotations['kubernetes.io/description'] ?? reg?.spec?.description ?? null,
        registrationType: reg?.spec?.type ?? null,
        serviceOwner: owner ?? null,
        serviceDisplayName: quotaServiceDisplayName(owner, resourceType),
      }
    })
}

function mapQuotaGrants(
  grantList: UpstreamResourceGrantList,
  regs: Map<string, UpstreamResourceRegistration>
) {
  return (grantList.items ?? []).map((g) => {
    const allowanceMap = new Map<string, number>()
    for (const allowance of g.spec?.allowances ?? []) {
      const rt = allowance.resourceType ?? ''
      const sum = (allowance.buckets ?? []).reduce((acc, b) => acc + (b?.amount ?? 0), 0)
      allowanceMap.set(rt, (allowanceMap.get(rt) ?? 0) + sum)
    }

    const allowances = Array.from(allowanceMap.entries()).map(([resourceType, amount]) => {
      const reg = regs.get(resourceType)
      const annotations = reg?.metadata?.annotations ?? {}
      const labels = reg?.metadata?.labels ?? {}
      const owner = labels['services.miloapis.com/owner'] ?? labels['services.miloapis.com/service']
      return {
        resourceType,
        displayName: quotaResourceDisplayName(annotations['kubernetes.io/display-name'], resourceType),
        serviceDisplayName: quotaServiceDisplayName(owner, resourceType),
        amount,
      }
    })

    return {
      name: g.metadata?.name ?? '',
      namespace: g.metadata?.namespace ?? '',
      createdAt: g.metadata?.creationTimestamp ?? null,
      autoCreated: g.metadata?.labels?.['quota.miloapis.com/auto-created'] === 'true',
      allowances,
      conditions: (g.status?.conditions ?? []).map((c) => ({
        type: c.type ?? '',
        status: c.status ?? '',
        message: c.message ?? null,
      })),
    }
  })
}

// ─────────────────────────────────────────────────────────────────────────────

function mapOrganization(raw: UpstreamOrganization) {
  const annotations = raw.metadata?.annotations ?? {}
  const displayName = annotations[PROJECT_DESCRIPTION_ANNOTATION] || raw.metadata?.name || ''
  const readyCondition = raw.status?.conditions?.find((c) => c.type === 'Ready')
  return {
    name: raw.metadata?.name ?? '',
    displayName,
    type: raw.spec?.type ?? '',
    createdAt: raw.metadata?.creationTimestamp ?? null,
    state: readyCondition?.status ?? null,
  }
}

function mapProjectFull(raw: UpstreamProjectFull) {
  const annotations = raw.metadata?.annotations ?? {}
  const displayName = annotations[PROJECT_DESCRIPTION_ANNOTATION] || raw.metadata?.name || ''
  const readyCondition = raw.status?.conditions?.find((c) => c.type === 'Ready')
  return {
    name: raw.metadata?.name ?? '',
    displayName,
    organizationName: raw.spec?.ownerRef?.name ?? '',
    createdAt: raw.metadata?.creationTimestamp ?? null,
    state: readyCondition?.status ?? null,
  }
}

function organizationsURL(params: { name?: string; limit?: number; cursor?: string; search?: string } = {}) {
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

    organizations: async (
      _root: unknown,
      args: { limit?: number; cursor?: string; search?: string },
      context: ResolverContext
    ) => {
      const authorization = getHeader(context, 'authorization')
      try {
        const url = organizationsURL({ limit: args.limit, cursor: args.cursor, search: args.search })
        const r = await getOriginalFetch()(url, {
          headers: { ...(authorization ? { Authorization: authorization } : {}), Accept: 'application/json' },
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
        log.error('organizations resolver failed', { error: error instanceof Error ? error.message : String(error) })
        return { items: [], continueToken: null }
      }
    },

    organization: async (_root: unknown, args: { name: string }, context: ResolverContext) => {
      const authorization = getHeader(context, 'authorization')
      try {
        const url = organizationsURL({ name: args.name })
        const r = await getOriginalFetch()(url, {
          headers: { ...(authorization ? { Authorization: authorization } : {}), Accept: 'application/json' },
        })
        if (!r.ok) {
          log.warn('milo organization fetch failed', { name: args.name, status: r.status })
          return null
        }
        return mapOrganization((await r.json()) as UpstreamOrganization)
      } catch (error) {
        log.error('organization resolver failed', { error: error instanceof Error ? error.message : String(error) })
        return null
      }
    },

    organizationProjects: async (
      _root: unknown,
      args: { orgName: string; limit?: number; cursor?: string },
      context: ResolverContext
    ) => {
      const authorization = getHeader(context, 'authorization')
      try {
        const url = orgProjectsURL(args.orgName, { limit: args.limit, cursor: args.cursor })
        const r = await getOriginalFetch()(url, {
          headers: { ...(authorization ? { Authorization: authorization } : {}), Accept: 'application/json' },
        })
        if (!r.ok) {
          log.warn('milo organizationProjects fetch failed', { orgName: args.orgName, status: r.status })
          return { items: [], continueToken: null }
        }
        const body = (await r.json()) as UpstreamProjectList
        return {
          items: (body.items ?? []).map(mapProjectFull),
          continueToken: body.metadata?.continue ?? null,
        }
      } catch (error) {
        log.error('organizationProjects resolver failed', { error: error instanceof Error ? error.message : String(error) })
        return { items: [], continueToken: null }
      }
    },

    organizationMembers: async (
      _root: unknown,
      args: { orgName: string },
      context: ResolverContext
    ) => {
      const authorization = getHeader(context, 'authorization')
      const headers = { ...(authorization ? { Authorization: authorization } : {}), Accept: 'application/json' }
      const fetchFn = getOriginalFetch()
      try {
        const [membershipsRes, invitationsRes] = await Promise.all([
          fetchFn(orgMembershipsURL(args.orgName), { headers }),
          fetchFn(orgInvitationsURL(args.orgName), { headers }),
        ])

        const result: {
          name: string; givenName: string | null; familyName: string | null; email: string
          roles: string[]; type: string; invitationState: string | null; createdAt: string | null
        }[] = []

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
            })
          }
        } else {
          log.warn('milo orgMemberships fetch failed', { orgName: args.orgName, status: membershipsRes.status })
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
            })
          }
        } else {
          log.warn('milo orgInvitations fetch failed', { orgName: args.orgName, status: invitationsRes.status })
        }

        return result
      } catch (error) {
        log.error('organizationMembers resolver failed', { error: error instanceof Error ? error.message : String(error) })
        return []
      }
    },

    projects: async (
      _root: unknown,
      args: { limit?: number; cursor?: string; search?: string },
      context: ResolverContext
    ) => {
      const authorization = getHeader(context, 'authorization')
      try {
        const url = projectsListURL({ limit: args.limit, cursor: args.cursor, search: args.search })
        const r = await getOriginalFetch()(url, {
          headers: { ...(authorization ? { Authorization: authorization } : {}), Accept: 'application/json' },
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
        log.error('projects resolver failed', { error: error instanceof Error ? error.message : String(error) })
        return { items: [], continueToken: null }
      }
    },

    project: async (_root: unknown, args: { name: string }, context: ResolverContext) => {
      const authorization = getHeader(context, 'authorization')
      try {
        const r = await getOriginalFetch()(projectURL(args.name), {
          headers: { ...(authorization ? { Authorization: authorization } : {}), Accept: 'application/json' },
        })
        if (!r.ok) {
          log.warn('milo project fetch failed', { name: args.name, status: r.status })
          return null
        }
        return mapProjectFull((await r.json()) as UpstreamProjectFull)
      } catch (error) {
        log.error('project resolver failed', { error: error instanceof Error ? error.message : String(error) })
        return null
      }
    },

    orgQuotaBuckets: async (_root: unknown, args: { orgName: string }, context: ResolverContext) => {
      const authorization = getHeader(context, 'authorization')
      const headers = { ...(authorization ? { Authorization: authorization } : {}), Accept: 'application/json' }
      const fetchFn = getOriginalFetch()
      try {
        const [bucketsRes, regsRes] = await Promise.all([
          fetchFn(orgQuotaBucketsURL(args.orgName), { headers }),
          fetchFn(resourceRegistrationsURL(), { headers }),
        ])
        const buckets: UpstreamAllowanceBucketList = bucketsRes.ok ? (await bucketsRes.json()) as UpstreamAllowanceBucketList : { items: [] }
        const regsBody: UpstreamResourceRegistrationList = regsRes.ok ? (await regsRes.json()) as UpstreamResourceRegistrationList : { items: [] }
        if (!bucketsRes.ok) log.warn('milo orgQuotaBuckets fetch failed', { orgName: args.orgName, status: bucketsRes.status })
        if (!regsRes.ok) log.warn('milo resourceRegistrations fetch failed', { status: regsRes.status })
        return { items: mapQuotaBuckets(buckets, buildRegistrationMap(regsBody)) }
      } catch (error) {
        log.error('orgQuotaBuckets resolver failed', { error: error instanceof Error ? error.message : String(error) })
        return { items: [] }
      }
    },

    projectQuotaBuckets: async (_root: unknown, args: { projectName: string }, context: ResolverContext) => {
      const authorization = getHeader(context, 'authorization')
      const headers = { ...(authorization ? { Authorization: authorization } : {}), Accept: 'application/json' }
      const fetchFn = getOriginalFetch()
      try {
        const [bucketsRes, regsRes] = await Promise.all([
          fetchFn(projectQuotaBucketsURL(args.projectName), { headers }),
          fetchFn(resourceRegistrationsURL(), { headers }),
        ])
        const buckets: UpstreamAllowanceBucketList = bucketsRes.ok ? (await bucketsRes.json()) as UpstreamAllowanceBucketList : { items: [] }
        const regsBody: UpstreamResourceRegistrationList = regsRes.ok ? (await regsRes.json()) as UpstreamResourceRegistrationList : { items: [] }
        if (!bucketsRes.ok) log.warn('milo projectQuotaBuckets fetch failed', { projectName: args.projectName, status: bucketsRes.status })
        if (!regsRes.ok) log.warn('milo resourceRegistrations fetch failed', { status: regsRes.status })
        return { items: mapQuotaBuckets(buckets, buildRegistrationMap(regsBody)) }
      } catch (error) {
        log.error('projectQuotaBuckets resolver failed', { error: error instanceof Error ? error.message : String(error) })
        return { items: [] }
      }
    },

    orgQuotaGrants: async (_root: unknown, args: { orgName: string }, context: ResolverContext) => {
      const authorization = getHeader(context, 'authorization')
      const headers = { ...(authorization ? { Authorization: authorization } : {}), Accept: 'application/json' }
      const fetchFn = getOriginalFetch()
      try {
        const [grantsRes, regsRes] = await Promise.all([
          fetchFn(orgQuotaGrantsURL(args.orgName), { headers }),
          fetchFn(resourceRegistrationsURL(), { headers }),
        ])
        const grants: UpstreamResourceGrantList = grantsRes.ok ? (await grantsRes.json()) as UpstreamResourceGrantList : { items: [] }
        const regsBody: UpstreamResourceRegistrationList = regsRes.ok ? (await regsRes.json()) as UpstreamResourceRegistrationList : { items: [] }
        if (!grantsRes.ok) log.warn('milo orgQuotaGrants fetch failed', { orgName: args.orgName, status: grantsRes.status })
        if (!regsRes.ok) log.warn('milo resourceRegistrations fetch failed', { status: regsRes.status })
        return { items: mapQuotaGrants(grants, buildRegistrationMap(regsBody)) }
      } catch (error) {
        log.error('orgQuotaGrants resolver failed', { error: error instanceof Error ? error.message : String(error) })
        return { items: [] }
      }
    },

    projectQuotaGrants: async (_root: unknown, args: { projectName: string }, context: ResolverContext) => {
      const authorization = getHeader(context, 'authorization')
      const headers = { ...(authorization ? { Authorization: authorization } : {}), Accept: 'application/json' }
      const fetchFn = getOriginalFetch()
      try {
        const [grantsRes, regsRes] = await Promise.all([
          fetchFn(projectQuotaGrantsURL(args.projectName), { headers }),
          fetchFn(resourceRegistrationsURL(), { headers }),
        ])
        const grants: UpstreamResourceGrantList = grantsRes.ok ? (await grantsRes.json()) as UpstreamResourceGrantList : { items: [] }
        const regsBody: UpstreamResourceRegistrationList = regsRes.ok ? (await regsRes.json()) as UpstreamResourceRegistrationList : { items: [] }
        if (!grantsRes.ok) log.warn('milo projectQuotaGrants fetch failed', { projectName: args.projectName, status: grantsRes.status })
        if (!regsRes.ok) log.warn('milo resourceRegistrations fetch failed', { status: regsRes.status })
        return { items: mapQuotaGrants(grants, buildRegistrationMap(regsBody)) }
      } catch (error) {
        log.error('projectQuotaGrants resolver failed', { error: error instanceof Error ? error.message : String(error) })
        return { items: [] }
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
