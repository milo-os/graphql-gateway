import { describe, expect, it, vi } from 'vitest'

vi.mock('@/shared/utils', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { UpstreamTimeoutError } from '@/gateway/clients/deadline'
import {
  UpstreamError,
  enrichmentFailure,
  failedEnrichment,
  failedPage,
  upstreamFailure,
} from './common'

const LIST = 'https://k8s.test/apis/resourcemanager.miloapis.com/v1alpha1/organizations?limit=50'

const responseWithCancelTracking = (status: number) => {
  let cancelled = false
  const body = new ReadableStream({
    cancel: () => {
      cancelled = true
    },
  })
  return { response: new Response(body, { status }), wasCancelled: () => cancelled }
}

describe('failedPage', () => {
  it('maps a 410 to CURSOR_EXPIRED only when the request carried a continue token', () => {
    expect(() => failedPage(new Response('{}', { status: 410 }), `${LIST}&continue=stale`)).toThrow(
      expect.objectContaining({
        extensions: { code: 'CURSOR_EXPIRED', status: 410, path: expect.any(String) },
      })
    )
    expect(() => failedPage(new Response('{}', { status: 410 }), LIST)).toThrow(
      expect.objectContaining({
        extensions: expect.objectContaining({ code: 'UPSTREAM_ERROR', status: 410 }),
      })
    )
  })

  it('maps any other status to UPSTREAM_ERROR carrying the status and path', () => {
    expect(() => failedPage(new Response('{}', { status: 503 }), LIST)).toThrow(
      expect.objectContaining({
        extensions: {
          code: 'UPSTREAM_ERROR',
          status: 503,
          path: '/apis/resourcemanager.miloapis.com/v1alpha1/organizations',
        },
      })
    )
  })

  it('cancels the unread body so the connection returns to the pool', () => {
    const { response, wasCancelled } = responseWithCancelTracking(500)
    expect(() => failedPage(response, LIST)).toThrow(UpstreamError)
    expect(wasCancelled()).toBe(true)
  })
})

describe('upstreamFailure', () => {
  it('keeps the cause on the error without putting its text in the client message', () => {
    const cause = new Error('connect ECONNREFUSED 10.0.0.1:443')
    const error = upstreamFailure(cause, 'users')
    expect(error.message).not.toContain('10.0.0.1')
    expect(error.originalError).toBe(cause)
    expect(error.extensions).toEqual({ code: 'UPSTREAM_ERROR' })
  })
})

describe('failedEnrichment', () => {
  const ORG = 'https://k8s.test/apis/resourcemanager.miloapis.com/v1alpha1/organizations/acme'

  it.each([
    [403, 'FORBIDDEN'],
    [401, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [500, 'UPSTREAM_UNAVAILABLE'],
    [503, 'UPSTREAM_UNAVAILABLE'],
  ])('maps %i to %s with the upstream path and no value', (status, code) => {
    const outcome = failedEnrichment(new Response('{}', { status }), 'organization acme', ORG)
    expect(outcome.value).toBeNull()
    expect(outcome.error).toMatchObject({
      extensions: {
        code,
        status,
        path: '/apis/resourcemanager.miloapis.com/v1alpha1/organizations/acme',
      },
    })
  })

  it('cancels the unread body so the connection returns to the pool', () => {
    const { response, wasCancelled } = responseWithCancelTracking(403)
    failedEnrichment(response, 'organization acme', ORG)
    expect(wasCancelled()).toBe(true)
  })
})

describe('enrichmentFailure', () => {
  it('keeps an upstream timeout code instead of flattening it', () => {
    const timeout = new UpstreamTimeoutError(
      'https://k8s.test/apis/resourcemanager.miloapis.com/v1alpha1/organizations/acme',
      10_000
    )
    const outcome = enrichmentFailure(timeout, 'organization acme')
    expect(outcome.value).toBeNull()
    expect(outcome.error).toMatchObject({ extensions: { code: 'UPSTREAM_TIMEOUT' } })
  })

  it('maps an unexpected error to UPSTREAM_UNAVAILABLE with the cause hidden', () => {
    const cause = new Error('connect ECONNREFUSED 10.0.0.1:443')
    const outcome = enrichmentFailure(cause, 'billing')
    expect(outcome.error).toMatchObject({
      message: expect.not.stringContaining('10.0.0.1'),
      extensions: { code: 'UPSTREAM_UNAVAILABLE' },
      originalError: cause,
    })
  })
})
