import { getK8sServer, getOriginalFetch } from '@/gateway/auth'
import { log } from '@/shared/utils'
import {
  DESCRIPTION_ANNOTATION,
  DISPLAY_NAME_ANNOTATION,
  getHeader,
  type ResolverContext,
} from './common'

/** Upper bound on upstream requests one GraphQL request keeps in flight. */
export const REQUEST_LOADER_CONCURRENCY = 8

export interface LoaderResult<T> {
  /** The loaded value, or null when the upstream had no usable answer. */
  value: T | null
  /** Upstream status when no value was returned, so callers can tell a 403 from a 404. */
  status: number | null
  /** Transport or parse failure, kept so a top-level resolver can rethrow a typed error. */
  error?: unknown
}

export interface UpstreamCondition {
  type?: string
  status?: string
  reason?: string
  message?: string
  lastTransitionTime?: string
  observedGeneration?: number
}

export interface UpstreamOrganization {
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
    conditions?: UpstreamCondition[]
  }
}

export interface UpstreamOrganizationList {
  items?: UpstreamOrganization[]
  metadata?: { continue?: string }
}

export interface UpstreamProjectFull {
  metadata?: {
    name?: string
    creationTimestamp?: string
    deletionTimestamp?: string
    annotations?: Record<string, string>
  }
  spec?: { ownerRef?: { name?: string; kind?: string } }
  status?: { conditions?: UpstreamCondition[] }
}

export interface UpstreamProjectList {
  items?: UpstreamProjectFull[]
  metadata?: { continue?: string }
}

interface UpstreamBillingAccount {
  metadata?: { name?: string; deletionTimestamp?: string }
  spec?: { defaultPaymentMethodRef?: { name?: string } }
}

interface UpstreamBillingAccountList {
  items?: UpstreamBillingAccount[]
}

interface UpstreamBillingAccountBinding {
  metadata?: { deletionTimestamp?: string }
  spec?: {
    billingAccountRef?: { name?: string }
    projectRef?: { name?: string }
  }
  status?: { phase?: string }
}

interface UpstreamBillingAccountBindingList {
  items?: UpstreamBillingAccountBinding[]
}

export interface MappedOrgContactInfo {
  businessName: string | null
  name: string | null
  email: string | null
}

export interface MappedCondition {
  type: string
  status: string
  reason: string | null
  message: string | null
  lastTransitionTime: string | null
  observedGeneration: number | null
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
  conditions: MappedCondition[]
}

export interface MappedProject {
  name: string
  displayName: string
  organizationName: string
  organizationDisplayName: string
  organizationBusinessName: string | null
  hasActiveBillingAccount: boolean
  billingAccountName: string | null
  createdAt: string | null
  state: string | null
  deletionTimestamp: string | null
  resourceCleanupMessage: string | null
  conditions: MappedCondition[]
}

export interface BillingEnrichment {
  hasActiveBillingAccount: boolean
  billingAccountName: string | null
}

type CompleteCondition = UpstreamCondition & { type: string; status: string }

function isCompleteCondition(condition: UpstreamCondition): condition is CompleteCondition {
  return Boolean(condition.type && condition.status)
}

// A condition without a type cannot be selected by name, and a missing status
// is not one of Kubernetes' True/False/Unknown values. Drop both rather than
// exposing them as empty strings behind non-null schema fields.
function mapConditions(conditions: UpstreamCondition[] | undefined): MappedCondition[] {
  return (conditions ?? []).filter(isCompleteCondition).map((condition) => ({
    type: condition.type,
    status: condition.status,
    reason: condition.reason ?? null,
    message: condition.message ?? null,
    lastTransitionTime: condition.lastTransitionTime ?? null,
    observedGeneration: condition.observedGeneration ?? null,
  }))
}

export function mapOrganization(raw: UpstreamOrganization): MappedOrganization {
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
    conditions: mapConditions(raw.status?.conditions),
  }
}

export function mapProjectFull(raw: UpstreamProjectFull): MappedProject {
  const annotations = raw.metadata?.annotations ?? {}
  const displayName =
    annotations[DISPLAY_NAME_ANNOTATION] ||
    annotations[DESCRIPTION_ANNOTATION] ||
    raw.metadata?.name ||
    ''
  const readyCondition = raw.status?.conditions?.find((c) => c.type === 'Ready')
  const cleanupCondition = raw.status?.conditions?.find((c) => c.type === 'ResourceCleanup')
  const organizationName = raw.spec?.ownerRef?.name ?? ''
  return {
    name: raw.metadata?.name ?? '',
    displayName,
    organizationName,
    // Defaults until attachOrganizationFields / a single-org enrichment runs.
    organizationDisplayName: organizationName,
    organizationBusinessName: null,
    hasActiveBillingAccount: false,
    billingAccountName: null,
    createdAt: raw.metadata?.creationTimestamp ?? null,
    state: readyCondition?.status ?? null,
    deletionTimestamp: raw.metadata?.deletionTimestamp ?? null,
    resourceCleanupMessage: cleanupCondition?.message?.trim() || null,
    conditions: mapConditions(raw.status?.conditions),
  }
}

export function organizationsURL(params: { name?: string; limit?: number; cursor?: string } = {}) {
  const server = getK8sServer()
  const base = `${server}/apis/resourcemanager.miloapis.com/v1alpha1/organizations`
  if (params.name) return `${base}/${encodeURIComponent(params.name)}`
  const query = new URLSearchParams()
  if (params.limit) query.set('limit', String(params.limit))
  if (params.cursor) query.set('continue', params.cursor)
  const qs = query.toString()
  return qs ? `${base}?${qs}` : base
}

// The Project object itself is read at the core resourcemanager API (no
// control-plane prefix) — that's where its annotations live.
function projectURL(name: string) {
  const server = getK8sServer()
  return `${server}/apis/resourcemanager.miloapis.com/v1alpha1/projects/${encodeURIComponent(name)}`
}

function orgBillingNamespace(orgName: string) {
  return `organization-${orgName}`
}

function orgBillingBindingsURL(orgName: string) {
  const server = getK8sServer()
  const ns = orgBillingNamespace(orgName)
  return (
    `${server}/apis/resourcemanager.miloapis.com/v1alpha1` +
    `/organizations/${encodeURIComponent(orgName)}/control-plane` +
    `/apis/billing.miloapis.com/v1alpha1/namespaces/${encodeURIComponent(ns)}/billingaccountbindings`
  )
}

function orgBillingAccountsURL(orgName: string) {
  const server = getK8sServer()
  const ns = orgBillingNamespace(orgName)
  return (
    `${server}/apis/resourcemanager.miloapis.com/v1alpha1` +
    `/organizations/${encodeURIComponent(orgName)}/control-plane` +
    `/apis/billing.miloapis.com/v1alpha1/namespaces/${encodeURIComponent(ns)}/billingaccounts`
  )
}

/**
 * Caps concurrent upstream requests for one request's loaders. One gate is
 * shared by the whole request, and a slot covers one upstream request rather
 * than one loader call, so a page that aliases both projects and orgs still
 * opens at most REQUEST_LOADER_CONCURRENCY sockets.
 */
class Semaphore {
  private active = 0
  private readonly waiting: Array<() => void> = []

  async run<T>(task: () => Promise<T>): Promise<T> {
    while (this.active >= REQUEST_LOADER_CONCURRENCY) {
      await new Promise<void>((resolve) => this.waiting.push(resolve))
    }
    this.active += 1
    try {
      return await task()
    } finally {
      this.active -= 1
      this.waiting.shift()?.()
    }
  }
}

/**
 * Dedupes keys for the life of one request. The first load for a key starts
 * the work and every later caller awaits the same promise, so concurrent
 * aliases coalesce instead of fanning out again. Failures are cached the same
 * way: every caller in the request sees the first outcome recorded for a key.
 */
class RequestLoader<K extends string, T> {
  private readonly cache = new Map<K, Promise<LoaderResult<T>>>()

  constructor(private readonly loadValue: (key: K) => Promise<LoaderResult<T>>) {}

  load(key: K): Promise<LoaderResult<T>> {
    const pending = this.cache.get(key)
    if (pending) return pending
    const started = this.loadValue(key)
    this.cache.set(key, started)
    return started
  }
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** Drops an unread body so the socket returns to the keep-alive pool. */
function discardBody(response: Response): void {
  void response.body?.cancel().catch(() => {})
}

export interface RequestLoaders {
  organization(name: string): Promise<LoaderResult<MappedOrganization>>
  project(name: string): Promise<LoaderResult<MappedProject>>
  billing(projectName: string, organizationName: string): Promise<LoaderResult<BillingEnrichment>>
}

/** Builds the three loaders for one request, bound to its authorization header. */
export function createRequestLoaders(context: ResolverContext): RequestLoaders {
  const authorization = getHeader(context, 'authorization')
  const headers: Record<string, string> = {
    ...(authorization ? { Authorization: authorization } : {}),
    Accept: 'application/json',
  }

  // One concurrency budget for the whole request. A slot is held until the
  // response headers arrive; reading the body happens outside the slot.
  const gate = new Semaphore()
  const fetchUpstream = (url: string) => gate.run(() => getOriginalFetch()(url, { headers }))

  const organization = new RequestLoader<string, MappedOrganization>(async (name) => {
    try {
      const response = await fetchUpstream(organizationsURL({ name }))
      if (!response.ok) {
        log.warn('milo organization fetch failed', { organization: name, status: response.status })
        discardBody(response)
        return { value: null, status: response.status }
      }
      return {
        value: mapOrganization((await response.json()) as UpstreamOrganization),
        status: null,
      }
    } catch (error) {
      log.warn('milo organization fetch threw', { organization: name, error: errorMessage(error) })
      return { value: null, status: null, error }
    }
  })

  const project = new RequestLoader<string, MappedProject>(async (name) => {
    try {
      const response = await fetchUpstream(projectURL(name))
      if (!response.ok) {
        log.warn('milo project fetch failed', { project: name, status: response.status })
        discardBody(response)
        return { value: null, status: response.status }
      }
      return { value: mapProjectFull((await response.json()) as UpstreamProjectFull), status: null }
    } catch (error) {
      log.warn('milo project fetch threw', { project: name, error: errorMessage(error) })
      return { value: null, status: null, error }
    }
  })

  const billingForOrg = new RequestLoader<string, Map<string, BillingEnrichment>>(
    async (orgName) => {
      try {
        const [bindingsRes, accountsRes] = await Promise.all([
          fetchUpstream(orgBillingBindingsURL(orgName)),
          fetchUpstream(orgBillingAccountsURL(orgName)),
        ])

        if (!bindingsRes.ok) {
          log.warn('milo billing bindings fetch failed', {
            organization: orgName,
            status: bindingsRes.status,
          })
          discardBody(bindingsRes)
          discardBody(accountsRes)
          return { value: null, status: bindingsRes.status }
        }
        if (!accountsRes.ok) {
          log.warn('milo billing accounts fetch failed', {
            organization: orgName,
            status: accountsRes.status,
          })
          discardBody(bindingsRes)
          discardBody(accountsRes)
          return { value: null, status: accountsRes.status }
        }

        const bindings =
          ((await bindingsRes.json()) as UpstreamBillingAccountBindingList).items ?? []
        const accounts = ((await accountsRes.json()) as UpstreamBillingAccountList).items ?? []

        const accountsWithPayment = new Set(
          accounts
            .filter(
              (account) =>
                !account.metadata?.deletionTimestamp &&
                Boolean(account.spec?.defaultPaymentMethodRef?.name?.trim())
            )
            .map((account) => account.metadata?.name)
            .filter((name): name is string => Boolean(name))
        )

        const byProject = new Map<string, BillingEnrichment>()
        for (const binding of bindings) {
          if (binding.metadata?.deletionTimestamp) continue
          const phase = binding.status?.phase
          if (phase && phase !== 'Active') continue

          const projectName = binding.spec?.projectRef?.name
          const accountName = binding.spec?.billingAccountRef?.name
          if (!projectName || !accountName) continue
          if (!accountsWithPayment.has(accountName)) continue

          byProject.set(projectName, {
            hasActiveBillingAccount: true,
            billingAccountName: accountName,
          })
        }

        return { value: byProject, status: null }
      } catch (error) {
        log.warn('milo billing enrichment threw', {
          organization: orgName,
          error: errorMessage(error),
        })
        return { value: null, status: null, error }
      }
    }
  )

  // A project's billing result comes from its org's binding list, so the org
  // list is fetched once however many projects share it.
  const organizationByProject = new Map<string, string>()
  const billing = new RequestLoader<string, BillingEnrichment>(async (projectName) => {
    const orgName = organizationByProject.get(projectName)
    if (!orgName) return { value: null, status: null }

    const orgResult = await billingForOrg.load(orgName)
    if (!orgResult.value) return { value: null, status: orgResult.status }
    return { value: orgResult.value.get(projectName) ?? null, status: null }
  })

  return {
    organization: (name) => organization.load(name),
    project: (name) => project.load(name),
    billing: (projectName, organizationName) => {
      if (organizationName) organizationByProject.set(projectName, organizationName)
      return billing.load(projectName)
    },
  }
}

// Keyed by the GraphQL context, which yoga creates per inbound request. A
// WeakMap keeps the loaders unreachable as soon as the request ends, and no
// caller can read them twice across requests because contexts are not reused.
const loadersByContext = new WeakMap<object, RequestLoaders>()

/** Establishes this request's loaders before resolvers run. */
export function attachRequestLoaders(context: unknown): void {
  if (typeof context !== 'object' || context === null) return
  if (!loadersByContext.has(context)) {
    loadersByContext.set(context, createRequestLoaders(context as ResolverContext))
  }
}

/**
 * The loaders for this resolver context. The plugin attaches them once per
 * execution; other entry points (direct resolver calls, tests) create the
 * same per-context instance lazily.
 */
export function getRequestLoaders(context: ResolverContext): RequestLoaders {
  const existing = loadersByContext.get(context)
  if (existing) return existing
  const loaders = createRequestLoaders(context)
  loadersByContext.set(context, loaders)
  return loaders
}
