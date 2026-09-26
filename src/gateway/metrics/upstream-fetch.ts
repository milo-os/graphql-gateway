import { Gauge, Histogram, register } from 'prom-client'

const DURATION_METRIC = 'graphql_gateway_local_fetch_duration_seconds'
const INFLIGHT_METRIC = 'graphql_gateway_local_fetch_inflight'

// Local resolvers call milo through the pre-override fetch (see
// getOriginalFetch), which the Hive Gateway fetch metrics never see. These
// cover that path. Registered on prom-client's default registry, which is the
// one usePrometheus serves on /metrics. Reuse an existing metric so a module
// reload (tests, dev) doesn't throw on duplicate registration.
const duration =
  (register.getSingleMetric(DURATION_METRIC) as Histogram<'resource' | 'method' | 'status'>) ??
  new Histogram({
    name: DURATION_METRIC,
    help: 'Time until response headers for upstream requests made by gateway-local resolvers.',
    labelNames: ['resource', 'method', 'status'],
    buckets: [0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  })

const inflight =
  (register.getSingleMetric(INFLIGHT_METRIC) as Gauge<'resource'>) ??
  new Gauge({
    name: INFLIGHT_METRIC,
    help: 'Upstream requests from gateway-local resolvers currently awaiting response headers.',
    labelNames: ['resource'],
  })

/**
 * Reduces a K8s API URL to its resource plural so the metric label stays
 * low-cardinality. Uses the innermost `/apis/<group>/<version>` (or
 * `/api/<version>`) so control-plane-prefixed paths resolve to the nested
 * resource, and skips `namespaces/<ns>`:
 *
 *   /apis/resourcemanager.miloapis.com/v1alpha1/namespaces/organization-acme/organizationmemberships
 *     -> organizationmemberships
 *   /apis/resourcemanager.miloapis.com/v1alpha1/organizations/acme
 *     -> organizations
 */
export function k8sResourceFromURL(url: string): string {
  let segments: string[]
  try {
    segments = new URL(url).pathname.split('/').filter(Boolean)
  } catch {
    return 'unknown'
  }

  let rest: string[] | null = null
  for (let i = 0; i < segments.length; i++) {
    if (segments[i] === 'apis' && i + 3 <= segments.length) rest = segments.slice(i + 3)
    else if (segments[i] === 'api' && i + 2 <= segments.length) rest = segments.slice(i + 2)
  }
  if (!rest) return 'unknown'
  if (rest[0] === 'namespaces' && rest.length > 2) rest = rest.slice(2)
  return rest[0] ?? 'unknown'
}

/** Wraps a fetch so each call records duration and in-flight count. */
export function instrumentFetch(fetchFn: typeof fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = (
      init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')
    ).toUpperCase()
    const resource = k8sResourceFromURL(url)

    inflight.inc({ resource })
    const end = duration.startTimer({ resource, method })
    try {
      const response = await fetchFn(input, init)
      end({ status: String(response.status) })
      return response
    } catch (error) {
      end({ status: 'error' })
      throw error
    } finally {
      inflight.dec({ resource })
    }
  }) as typeof fetch
}
