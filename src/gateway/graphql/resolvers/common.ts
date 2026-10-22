import { GraphQLError } from 'graphql'
import { pathOf } from '@/gateway/clients/deadline'

/**
 * Hive Gateway runs on graphql-yoga, which exposes incoming request headers
 * via `context.request.headers` (a Web Headers instance). The federated
 * mesh-mapping resolvers in compose-worker.ts read headers via the
 * `context.headers[name]` flat-object shape provided by graphql-mesh's
 * runtime. Hand-written local resolvers see only the yoga shape, so we
 * support both and fall back to the empty string when neither is present.
 */
export interface ResolverContext {
  request?: { headers?: Headers }
  headers?: Record<string, string | undefined>
}

export function getHeader(context: ResolverContext, name: string): string {
  const yogaValue = context.request?.headers?.get?.(name)
  if (yogaValue) return yogaValue
  const meshValue = context.headers?.[name] ?? context.headers?.[name.toLowerCase()]
  return meshValue ?? ''
}

/**
 * Paginated list resolvers surface a failed page as a typed GraphQLError
 * (see failedPage and upstreamFailure); best-effort, non-paginated resolvers
 * still catch everything and degrade to an empty result so one bad upstream
 * call does not fail the whole operation. Either way a typed GraphQLError
 * already carries a code the client can act on, so it must reach the
 * response instead of being logged and swallowed. Call this first in every
 * top-level catch block.
 */
export function rethrowGraphQLError(error: unknown): void {
  if (error instanceof GraphQLError) throw error
}

type UpstreamErrorCode = 'UPSTREAM_ERROR' | 'CURSOR_EXPIRED'

const hadContinueToken = (url: string): boolean => {
  try {
    return new URL(url).searchParams.has('continue')
  } catch {
    return false
  }
}

/** A list page that could not be fetched. Carries a code the client can branch on. */
export class UpstreamError extends GraphQLError {
  constructor(
    message: string,
    extensions: { code: UpstreamErrorCode; status?: number; path?: string },
    originalError?: Error
  ) {
    super(message, { extensions, originalError })
    this.name = 'UpstreamError'
  }
}

/**
 * Turns a non-OK list response into a thrown error. A failed page must reach
 * the client as an error: returning an empty page with no continue token is
 * indistinguishable from the end of the list, so the portal stops paging and
 * the user sees a truncated list. 410 Gone is the apiserver saying the
 * continue token expired from the watch cache; the client should restart
 * from the first page.
 */
export function failedPage(response: Response, url: string): never {
  const path = pathOf(url)
  // An unread body keeps the socket out of the keep-alive pool until GC.
  void response.body?.cancel().catch(() => {})
  if (response.status === 410 && hadContinueToken(url)) {
    throw new UpstreamError(`Continue token expired for ${path}`, {
      code: 'CURSOR_EXPIRED',
      status: 410,
      path,
    })
  }
  throw new UpstreamError(`Upstream request to ${path} failed with ${response.status}`, {
    code: 'UPSTREAM_ERROR',
    status: response.status,
    path,
  })
}

/**
 * Wraps an unexpected error from a page fetch (network, parse) as
 * UPSTREAM_ERROR. The cause is kept as originalError for error tracking but
 * its text is not repeated to the client, because it can carry internal
 * addresses.
 */
export function upstreamFailure(error: unknown, what: string): UpstreamError {
  return new UpstreamError(
    `${what} failed upstream`,
    { code: 'UPSTREAM_ERROR' },
    error instanceof Error ? error : undefined
  )
}

/** Codes a portal can branch on when an enrichment field degrades to null. */
export type EnrichmentErrorCode =
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'UPSTREAM_UNAVAILABLE'
  | 'UPSTREAM_TIMEOUT'

/**
 * Outcome of a per-item enrichment lookup. On failure the value is null and
 * the error carries a code and upstream path; the field resolver throws it so
 * graphql-js reports the error on that field's path while the rest of the row
 * still resolves.
 */
export type EnrichmentOutcome<T> = { value: T; error: null } | { value: null; error: GraphQLError }

const enrichmentCodeForStatus = (status: number): EnrichmentErrorCode => {
  if (status === 401 || status === 403) return 'FORBIDDEN'
  if (status === 404) return 'NOT_FOUND'
  return 'UPSTREAM_UNAVAILABLE'
}

/**
 * Turns a non-OK upstream status into `{ value: null, error }` so callers do
 * not re-implement status mapping. 401/403 become FORBIDDEN, 404 becomes
 * NOT_FOUND, and everything else is UPSTREAM_UNAVAILABLE. The error's
 * extensions.path is the upstream path, never the caller's query string.
 *
 * Loaders keep the status of a failed read (and discard the body), so this is
 * the entry point for enrichment built on request-scoped loaders.
 */
export function enrichmentFailureFromStatus(
  status: number,
  what: string,
  url: string
): EnrichmentOutcome<never> {
  const path = pathOf(url)
  return {
    value: null,
    error: new GraphQLError(`${what} could not be read from ${path}`, {
      extensions: {
        code: enrichmentCodeForStatus(status),
        status,
        path,
      },
    }),
  }
}

/**
 * Turns a non-OK enrichment response into `{ value: null, error }`. The body
 * is discarded so the socket returns to the keep-alive pool.
 */
export function failedEnrichment(
  response: Response,
  what: string,
  url: string
): EnrichmentOutcome<never> {
  // An unread body keeps the socket out of the keep-alive pool until GC.
  void response.body?.cancel().catch(() => {})
  return enrichmentFailureFromStatus(response.status, what, url)
}

/**
 * Turns a thrown enrichment failure into `{ value: null, error }`. A
 * GraphQLError (including UpstreamTimeoutError) already carries the right
 * code, so it is kept as-is; anything else becomes UPSTREAM_UNAVAILABLE with
 * the cause hidden from the client message.
 */
export function enrichmentFailure(error: unknown, what: string): EnrichmentOutcome<never> {
  if (error instanceof GraphQLError) return { value: null, error }
  return {
    value: null,
    error: new GraphQLError(`${what} failed upstream`, {
      extensions: { code: 'UPSTREAM_UNAVAILABLE' },
      originalError: error instanceof Error ? error : undefined,
    }),
  }
}

export const DESCRIPTION_ANNOTATION = 'kubernetes.io/description'
export const DISPLAY_NAME_ANNOTATION = 'kubernetes.io/display-name'
