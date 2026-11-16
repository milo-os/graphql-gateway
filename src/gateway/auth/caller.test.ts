import { describe, expect, it, vi } from 'vitest'
import {
  VERDICT_TTL_MS,
  bearerToken,
  createCallerCache,
  reviewToken,
  verdictFromReview,
} from './caller'
import type { CallerVerdict } from './caller'

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const review = (username: string) => ({
  kind: 'SelfSubjectReview',
  status: { userInfo: { username } },
})

describe('bearerToken', () => {
  it.each([
    ['Bearer abc.def', 'abc.def'],
    ['bearer abc', 'abc'],
    ['Bearer   abc  ', 'abc'],
    [['Bearer first', 'Bearer second'], 'first'],
  ])('reads %j', (header, expected) => {
    expect(bearerToken(header)).toBe(expected)
  })

  it.each([undefined, '', 'Bearer', 'Bearer ', 'Basic dXNlcjpwYXNz', 'Bearer a b', 'abc'])(
    'finds no token in %j',
    (header) => {
      expect(bearerToken(header)).toBeNull()
    }
  )
})

describe('verdictFromReview', () => {
  it('accepts a user Milo names', async () => {
    expect(await verdictFromReview(json(201, review('alice@example.com')))).toBe('authenticated')
  })

  it('refuses the anonymous user', async () => {
    expect(await verdictFromReview(json(201, review('system:anonymous')))).toBe('unauthenticated')
  })

  it('refuses a review that names nobody', async () => {
    expect(await verdictFromReview(json(201, {}))).toBe('unauthenticated')
  })

  it('refuses a token Milo cannot authenticate', async () => {
    expect(await verdictFromReview(json(401, { message: 'Unauthorized' }))).toBe('unauthenticated')
  })

  it('accepts a user Milo authenticated but will not let review itself', async () => {
    const forbidden = json(403, {
      message: 'selfsubjectreviews.authentication.k8s.io is forbidden: User "alice@example.com"',
    })
    expect(await verdictFromReview(forbidden)).toBe('authenticated')
  })

  it('refuses a 403 addressed to the anonymous user', async () => {
    const forbidden = json(403, {
      message: 'selfsubjectreviews.authentication.k8s.io is forbidden: User "system:anonymous"',
    })
    expect(await verdictFromReview(forbidden)).toBe('unauthenticated')
  })

  it.each([429, 500, 503])('cannot tell from a %s', async (status) => {
    expect(await verdictFromReview(json(status, {}))).toBe('unavailable')
  })
})

describe('reviewToken', () => {
  it("posts a SelfSubjectReview with the caller's token", async () => {
    const fetchFn = vi.fn(async () => json(201, review('alice@example.com')))

    const verdict = await reviewToken(
      'tok',
      fetchFn as unknown as typeof fetch,
      'https://milo:6443'
    )

    expect(verdict).toBe('authenticated')
    expect(fetchFn).toHaveBeenCalledWith(
      'https://milo:6443/apis/authentication.k8s.io/v1/selfsubjectreviews',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer tok' }),
      })
    )
  })

  it('cannot tell when the call fails', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED')
    })
    expect(await reviewToken('tok', fetchFn as unknown as typeof fetch, 'https://milo')).toBe(
      'unavailable'
    )
  })
})

describe('createCallerCache', () => {
  const setup = (verdicts: CallerVerdict[], maxEntries?: number) => {
    let clock = 0
    const reviewFn = vi.fn(async (_token: string) => verdicts.shift() ?? 'authenticated')
    const check = createCallerCache({ review: reviewFn, now: () => clock, maxEntries })
    return { check, reviewFn, advance: (ms: number) => (clock += ms) }
  }

  it('reuses an accepted token until it expires', async () => {
    const { check, reviewFn, advance } = setup(['authenticated', 'unauthenticated'])

    expect(await check('tok')).toBe('authenticated')
    advance(VERDICT_TTL_MS.authenticated - 1)
    expect(await check('tok')).toBe('authenticated')
    expect(reviewFn).toHaveBeenCalledTimes(1)

    advance(1)
    expect(await check('tok')).toBe('unauthenticated')
    expect(reviewFn).toHaveBeenCalledTimes(2)
  })

  it('remembers a rejected token for less time', async () => {
    const { check, reviewFn, advance } = setup(['unauthenticated', 'authenticated'])

    expect(await check('tok')).toBe('unauthenticated')
    advance(VERDICT_TTL_MS.unauthenticated)
    expect(await check('tok')).toBe('authenticated')
    expect(reviewFn).toHaveBeenCalledTimes(2)
  })

  it('asks again after Milo could not answer', async () => {
    const { check, reviewFn } = setup(['unavailable', 'authenticated'])

    expect(await check('tok')).toBe('unavailable')
    expect(await check('tok')).toBe('authenticated')
    expect(reviewFn).toHaveBeenCalledTimes(2)
  })

  it('shares one review between concurrent requests with the same token', async () => {
    const { check, reviewFn } = setup(['authenticated'])

    const verdicts = await Promise.all([check('tok'), check('tok'), check('tok')])

    expect(verdicts).toEqual(['authenticated', 'authenticated', 'authenticated'])
    expect(reviewFn).toHaveBeenCalledTimes(1)
  })

  it('reviews each token separately', async () => {
    const { check, reviewFn } = setup(['authenticated', 'unauthenticated'])

    expect(await check('good')).toBe('authenticated')
    expect(await check('bad')).toBe('unauthenticated')
    expect(reviewFn).toHaveBeenCalledWith('good')
    expect(reviewFn).toHaveBeenCalledWith('bad')
  })

  it('forgets the oldest token past its limit', async () => {
    const { check, reviewFn } = setup([], 2)

    await check('a')
    await check('b')
    await check('c')
    await check('a')

    expect(reviewFn.mock.calls.map(([token]) => token)).toEqual(['a', 'b', 'c', 'a'])
  })

  it('treats a review that throws as Milo not answering, and asks again next time', async () => {
    const reviewFn = vi
      .fn<(token: string) => Promise<CallerVerdict>>()
      .mockImplementationOnce(() => {
        throw new Error('K8s auth not initialized')
      })
      .mockResolvedValueOnce('authenticated')
    const check = createCallerCache({ review: reviewFn })

    expect(await check('tok')).toBe('unavailable')
    expect(await check('tok')).toBe('authenticated')
  })
})
