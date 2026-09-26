import { describe, expect, it, vi } from 'vitest'
import { register } from 'prom-client'
import { instrumentFetch, k8sResourceFromURL } from './upstream-fetch'

const K8S = 'https://k8s.test'

describe('k8sResourceFromURL', () => {
  it.each([
    [
      `${K8S}/apis/resourcemanager.miloapis.com/v1alpha1/namespaces/organization-acme/organizationmemberships`,
      'organizationmemberships',
    ],
    [
      `${K8S}/apis/iam.miloapis.com/v1alpha1/namespaces/organization-acme/userinvitations`,
      'userinvitations',
    ],
    [`${K8S}/apis/resourcemanager.miloapis.com/v1alpha1/organizations/acme`, 'organizations'],
    [`${K8S}/apis/resourcemanager.miloapis.com/v1alpha1/organizations?limit=10`, 'organizations'],
    [
      `${K8S}/apis/resourcemanager.miloapis.com/v1alpha1/organizations/acme/control-plane` +
        `/apis/billing.miloapis.com/v1alpha1/namespaces/organization-acme/billingaccounts`,
      'billingaccounts',
    ],
    [
      `${K8S}/apis/iam.miloapis.com/v1alpha1/users/u1/control-plane/apis/identity.miloapis.com/v1alpha1/useridentities`,
      'useridentities',
    ],
    [`${K8S}/api/v1/namespaces/default`, 'namespaces'],
    [`${K8S}/healthz`, 'unknown'],
    ['not a url', 'unknown'],
  ])('%s -> %s', (url, expected) => {
    expect(k8sResourceFromURL(url)).toBe(expected)
  })
})

describe('instrumentFetch', () => {
  const sampleCount = async (labels: Record<string, string>) => {
    const metric = await register
      .getSingleMetric('graphql_gateway_local_fetch_duration_seconds')!
      .get()
    // Histogram values carry metricName (_bucket/_sum/_count); the shared
    // MetricValue type doesn't declare it.
    const match = (
      metric.values as Array<(typeof metric.values)[number] & { metricName?: string }>
    ).find(
      (v) =>
        v.metricName === 'graphql_gateway_local_fetch_duration_seconds_count' &&
        Object.entries(labels).every(([k, val]) => v.labels[k] === val)
    )
    return match?.value ?? 0
  }

  const inflightValue = async (resource: string) => {
    const metric = await register.getSingleMetric('graphql_gateway_local_fetch_inflight')!.get()
    return metric.values.find((v) => v.labels.resource === resource)?.value ?? 0
  }

  it('records duration with the response status and tracks in-flight requests', async () => {
    let release!: (r: Response) => void
    const inner = vi.fn(() => new Promise<Response>((r) => (release = r)))
    const fetchFn = instrumentFetch(inner as unknown as typeof fetch)
    const labels = { resource: 'userinvitations', method: 'GET', status: '200' }
    const before = await sampleCount(labels)

    const pending = fetchFn(
      `${K8S}/apis/iam.miloapis.com/v1alpha1/namespaces/organization-acme/userinvitations`
    )
    expect(await inflightValue('userinvitations')).toBe(1)

    release(new Response('{}', { status: 200 }))
    await pending
    expect(await inflightValue('userinvitations')).toBe(0)
    expect(await sampleCount(labels)).toBe(before + 1)
  })

  it('records status "error" and rethrows when the fetch throws', async () => {
    const fetchFn = instrumentFetch(vi.fn().mockRejectedValue(new Error('boom')))
    const labels = { resource: 'organizations', method: 'DELETE', status: 'error' }
    const before = await sampleCount(labels)

    await expect(
      fetchFn(`${K8S}/apis/resourcemanager.miloapis.com/v1alpha1/organizations/acme`, {
        method: 'delete',
      })
    ).rejects.toThrow('boom')
    expect(await sampleCount(labels)).toBe(before + 1)
    expect(await inflightValue('organizations')).toBe(0)
  })
})
