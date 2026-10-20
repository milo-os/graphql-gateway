import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GraphQLError } from 'graphql'
import { UpstreamTimeoutError, withDeadline } from './deadline'

const URL_ORGS = 'https://k8s.test/apis/resourcemanager.miloapis.com/v1alpha1/organizations?limit=5'

/** A fetch that never answers but does honour its abort signal, like undici. */
const hangingFetch = () =>
  vi.fn(
    (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))
      })
  )

describe('withDeadline', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('rejects with UPSTREAM_TIMEOUT carrying the path and deadline when headers never arrive', async () => {
    const fetchFn = withDeadline(hangingFetch() as unknown as typeof fetch, { timeoutMs: 100 })

    const settled = fetchFn(URL_ORGS).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(100)
    const error = await settled

    expect(error).toBeInstanceOf(UpstreamTimeoutError)
    expect(error).toBeInstanceOf(GraphQLError)
    expect(error).toMatchObject({
      extensions: {
        code: 'UPSTREAM_TIMEOUT',
        timeoutMs: 100,
        path: '/apis/resourcemanager.miloapis.com/v1alpha1/organizations',
      },
    })
  })

  it('aborts the inner request when the deadline passes, even if the inner fetch ignores the signal', async () => {
    let seenSignal: AbortSignal | undefined
    const ignoresSignal = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      seenSignal = init?.signal ?? undefined
      return new Promise<Response>(() => {})
    })
    const fetchFn = withDeadline(ignoresSignal as unknown as typeof fetch, { timeoutMs: 50 })

    const settled = fetchFn(URL_ORGS).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(50)

    expect(await settled).toBeInstanceOf(UpstreamTimeoutError)
    expect(seenSignal?.aborted).toBe(true)
    expect(seenSignal?.reason).toBeInstanceOf(UpstreamTimeoutError)
  })

  it('returns the response and clears the timer when headers arrive in time', async () => {
    const inner = vi.fn(async () => new Response('{}', { status: 200 }))
    const fetchFn = withDeadline(inner as unknown as typeof fetch, { timeoutMs: 100 })

    const response = await fetchFn(URL_ORGS)

    expect(response.status).toBe(200)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('settles with the caller reason even when the inner fetch ignores the signal', async () => {
    const ignoresSignal = vi.fn(() => new Promise<Response>(() => {}))
    const fetchFn = withDeadline(ignoresSignal as unknown as typeof fetch, { timeoutMs: 100 })
    const caller = new AbortController()

    const settled = fetchFn(URL_ORGS, { signal: caller.signal }).catch((error: unknown) => error)
    caller.abort(new DOMException('client went away', 'AbortError'))
    await vi.advanceTimersByTimeAsync(0)

    expect(await settled).toMatchObject({ name: 'AbortError', message: 'client went away' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects at once with the caller reason when the signal is already aborted', async () => {
    const inner = vi.fn(async () => new Response('{}'))
    const fetchFn = withDeadline(inner as unknown as typeof fetch, { timeoutMs: 100 })
    const caller = new AbortController()
    caller.abort(new DOMException('gone before start', 'AbortError'))

    await expect(fetchFn(URL_ORGS, { signal: caller.signal })).rejects.toMatchObject({
      message: 'gone before start',
    })
    expect(inner).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('honours the signal carried by a Request input when init has none', async () => {
    const fetchFn = withDeadline(hangingFetch() as unknown as typeof fetch, { timeoutMs: 100 })
    const caller = new AbortController()

    const settled = fetchFn(new Request(URL_ORGS, { signal: caller.signal })).catch(
      (error: unknown) => error
    )
    caller.abort(new DOMException('client went away', 'AbortError'))

    expect(await settled).toMatchObject({ name: 'AbortError', message: 'client went away' })
  })

  it('keeps the caller abort reason when the caller aborts before the deadline', async () => {
    const fetchFn = withDeadline(hangingFetch() as unknown as typeof fetch, { timeoutMs: 100 })
    const caller = new AbortController()

    const settled = fetchFn(URL_ORGS, { signal: caller.signal }).catch((error: unknown) => error)
    caller.abort(new DOMException('client went away', 'AbortError'))

    expect(await settled).toMatchObject({ name: 'AbortError', message: 'client went away' })
    expect(vi.getTimerCount()).toBe(0)
  })
})
