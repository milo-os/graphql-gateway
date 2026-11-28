import { createHash } from 'node:crypto'

/**
 * What the gateway knows about the caller of a GraphQL request.
 *
 * - `authenticated`: Milo accepted the bearer token.
 * - `missing`: the request carried no bearer token.
 * - `unauthenticated`: Milo rejected the token, or took it as anonymous.
 * - `unavailable`: Milo could not be asked, so the token is unknown.
 */
export type CallerVerdict = 'authenticated' | 'missing' | 'unauthenticated' | 'unavailable'

export const ANONYMOUS_USER = 'system:anonymous'

const REVIEW_PATH = '/apis/authentication.k8s.io/v1/selfsubjectreviews'
const REVIEW_BODY = JSON.stringify({
  apiVersion: 'authentication.k8s.io/v1',
  kind: 'SelfSubjectReview',
})

/** How long each answer is reused for the same token, in milliseconds. */
export const VERDICT_TTL_MS: Readonly<Record<'authenticated' | 'unauthenticated', number>> = {
  authenticated: 60_000,
  unauthenticated: 10_000,
}

/** Most tokens remembered at once. The oldest is forgotten first. */
export const MAX_CACHED_TOKENS = 10_000

/**
 * The token from an `Authorization: Bearer <token>` header, or null when the
 * header is missing, uses another scheme, or carries no token.
 */
export const bearerToken = (header: string | string[] | undefined): string | null => {
  const value = Array.isArray(header) ? header[0] : header
  const match = value?.match(/^Bearer[ \t]+(\S+)[ \t]*$/i)
  return match ? match[1] : null
}

const usernameOf = (body: unknown): string | undefined => {
  const status = (body as { status?: { userInfo?: { username?: unknown } } } | null)?.status
  const username = status?.userInfo?.username
  return typeof username === 'string' ? username : undefined
}

const readJson = async (response: Response): Promise<unknown> => {
  try {
    return await response.json()
  } catch {
    return null
  }
}

/**
 * Turns Milo's answer to a SelfSubjectReview into a verdict.
 *
 * A token Milo cannot authenticate gets 401. A 403 means Milo authenticated
 * the token but does not let that user review itself, unless the refusal is
 * addressed to the anonymous user. Anything else means Milo could not answer.
 */
export const verdictFromReview = async (response: Response): Promise<CallerVerdict> => {
  if (response.status === 401) {
    void response.body?.cancel().catch(() => {})
    return 'unauthenticated'
  }
  if (response.ok) {
    const username = usernameOf(await readJson(response))
    return username && username !== ANONYMOUS_USER ? 'authenticated' : 'unauthenticated'
  }
  if (response.status === 403) {
    const message = (await readJson(response)) as { message?: unknown } | null
    const text = typeof message?.message === 'string' ? message.message : ''
    return text.includes(`"${ANONYMOUS_USER}"`) ? 'unauthenticated' : 'authenticated'
  }
  void response.body?.cancel().catch(() => {})
  return 'unavailable'
}

/**
 * Asks Milo who the token belongs to. The fetch must not present the
 * gateway's client certificate, or Milo would answer for the gateway.
 */
export const reviewToken = async (
  token: string,
  fetchFn: typeof fetch,
  server: string
): Promise<CallerVerdict> => {
  try {
    const response = await fetchFn(`${server}${REVIEW_PATH}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: REVIEW_BODY,
    })
    return await verdictFromReview(response)
  } catch {
    return 'unavailable'
  }
}

const tokenKey = (token: string): string => createHash('sha256').update(token).digest('hex')

interface CacheEntry {
  verdict: Promise<CallerVerdict>
  expiresAt: number
}

export interface CallerCacheOptions {
  review: (token: string) => Promise<CallerVerdict>
  now?: () => number
  maxEntries?: number
}

/**
 * Remembers verdicts by token hash, so a busy client costs Milo one review a
 * minute instead of one per request. Concurrent requests with the same token
 * share one review. An `unavailable` answer is never remembered.
 */
export const createCallerCache = ({
  review,
  now = Date.now,
  maxEntries = MAX_CACHED_TOKENS,
}: CallerCacheOptions) => {
  const entries = new Map<string, CacheEntry>()

  const forgetOldest = (): void => {
    const oldest = entries.keys().next()
    if (!oldest.done) entries.delete(oldest.value)
  }

  // A review that throws, even synchronously, counts as Milo not answering.
  const safeReview = (token: string): Promise<CallerVerdict> =>
    Promise.resolve()
      .then(() => review(token))
      .catch((): CallerVerdict => 'unavailable')

  const remember = (key: string, token: string): Promise<CallerVerdict> => {
    const entry: CacheEntry = { verdict: safeReview(token), expiresAt: Infinity }
    entries.set(key, entry)
    while (entries.size > maxEntries) forgetOldest()
    entry.verdict.then((verdict) => {
      if (entries.get(key) !== entry) return
      if (verdict === 'authenticated' || verdict === 'unauthenticated') {
        entry.expiresAt = now() + VERDICT_TTL_MS[verdict]
      } else {
        entries.delete(key)
      }
    })
    return entry.verdict
  }

  return (token: string): Promise<CallerVerdict> => {
    const key = tokenKey(token)
    const entry = entries.get(key)
    if (entry && entry.expiresAt > now()) return entry.verdict
    if (entry) entries.delete(key)
    return remember(key, token)
  }
}
