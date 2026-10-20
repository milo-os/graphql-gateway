import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { context, propagation, trace } from '@opentelemetry/api'
import { W3CTraceContextPropagator } from '@opentelemetry/core'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { runWithRequestContext } from '@/shared/request-context'
import { withCorrelation } from './correlation'

const URL_ORGS = 'https://k8s.test/apis/resourcemanager.miloapis.com/v1alpha1/organizations'

const capture = () => {
  const inner = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
    return new Response('{}', { status: 200, headers: { 'x-seen': 'yes' } })
  })
  const headersOfCall = (n = 0) => new Headers(inner.mock.calls[n]![1]?.headers)
  return { inner, headersOfCall }
}

describe('withCorrelation', () => {
  const contextManager = new AsyncLocalStorageContextManager()

  beforeAll(() => {
    context.setGlobalContextManager(contextManager.enable())
    propagation.setGlobalPropagator(new W3CTraceContextPropagator())
  })
  afterAll(() => {
    context.disable()
    propagation.disable()
  })

  it('stamps x-request-id and the gateway-generated Audit-ID from the request context', async () => {
    const { inner, headersOfCall } = capture()
    const fetchFn = withCorrelation(inner as unknown as typeof fetch)

    await runWithRequestContext({ requestId: 'req-42', auditId: 'audit-7' }, () =>
      fetchFn(URL_ORGS)
    )

    expect(headersOfCall().get('x-request-id')).toBe('req-42')
    expect(headersOfCall().get('audit-id')).toBe('audit-7')
  })

  it('overrides correlation headers a caller set but keeps its other headers', async () => {
    const { inner, headersOfCall } = capture()
    const fetchFn = withCorrelation(inner as unknown as typeof fetch)

    await runWithRequestContext({ requestId: 'req-42', auditId: 'audit-7' }, () =>
      fetchFn(URL_ORGS, {
        headers: { Authorization: 'Bearer t', 'x-request-id': 'mine', 'audit-id': 'forged' },
      })
    )

    expect(headersOfCall().get('authorization')).toBe('Bearer t')
    expect(headersOfCall().get('x-request-id')).toBe('req-42')
    expect(headersOfCall().get('audit-id')).toBe('audit-7')
  })

  it('reads headers off a Request input and leaves the caller objects untouched', async () => {
    const { inner, headersOfCall } = capture()
    const fetchFn = withCorrelation(inner as unknown as typeof fetch)
    const request = new Request(URL_ORGS, { headers: { Authorization: 'Bearer t' } })

    await runWithRequestContext({ requestId: 'req-42', auditId: 'audit-7' }, () => fetchFn(request))

    expect(headersOfCall().get('authorization')).toBe('Bearer t')
    expect(headersOfCall().get('x-request-id')).toBe('req-42')
    expect(request.headers.has('x-request-id')).toBe(false)
  })

  it('adds no correlation headers outside of a request', async () => {
    const { inner, headersOfCall } = capture()
    const fetchFn = withCorrelation(inner as unknown as typeof fetch)

    await fetchFn(URL_ORGS)

    expect(headersOfCall().has('x-request-id')).toBe(false)
    expect(headersOfCall().has('audit-id')).toBe(false)
  })

  it('injects traceparent from the active span', async () => {
    const { inner, headersOfCall } = capture()
    const fetchFn = withCorrelation(inner as unknown as typeof fetch)
    const spanContext = {
      traceId: '0af7651916cd43dd8448eb211c80319c',
      spanId: 'b7ad6b7169203331',
      traceFlags: 1,
    }
    const ctx = trace.setSpanContext(context.active(), spanContext)

    await context.with(ctx, () => fetchFn(URL_ORGS))

    expect(headersOfCall().get('traceparent')).toBe(
      '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'
    )
  })

  it('leaves a traceparent the caller already set', async () => {
    const { inner, headersOfCall } = capture()
    const fetchFn = withCorrelation(inner as unknown as typeof fetch)
    const ctx = trace.setSpanContext(context.active(), {
      traceId: '0af7651916cd43dd8448eb211c80319c',
      spanId: 'b7ad6b7169203331',
      traceFlags: 1,
    })

    await context.with(ctx, () =>
      fetchFn(URL_ORGS, {
        headers: { traceparent: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01' },
      })
    )

    expect(headersOfCall().get('traceparent')).toBe(
      '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01'
    )
  })
})
