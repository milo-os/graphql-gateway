import { describe, expect, it, vi } from 'vitest'

vi.mock('@/shared/utils', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { UpstreamError, failedPage, upstreamFailure } from './common'

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
