import { getOriginalFetch, getK8sServer } from '@/gateway/auth'
import { log } from '@/shared/utils'
import { type ResolverContext, getHeader } from './common'

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

export const quotaResolvers = {
  Query: {
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
}
