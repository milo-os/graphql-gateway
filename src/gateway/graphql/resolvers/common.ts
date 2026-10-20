import { GraphQLError } from 'graphql'

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
 * Page-level resolvers catch everything and degrade to an empty result so one
 * bad upstream call does not fail the whole operation. A typed GraphQLError
 * (for example UpstreamTimeoutError) is the exception: it already carries a
 * code the client can act on, so it must reach the response instead of being
 * logged and swallowed. Call this first in a page-level catch block.
 */
export function rethrowGraphQLError(error: unknown): void {
  if (error instanceof GraphQLError) throw error
}

type UpstreamErrorCode = 'UPSTREAM_ERROR' | 'CURSOR_EXPIRED'

const pathOf = (url: string): string => {
  try {
    return new URL(url).pathname
  } catch {
    return url
  }
}

/** A list page that could not be fetched. Carries a code the client can branch on. */
export class UpstreamError extends GraphQLError {
  constructor(
    message: string,
    extensions: { code: UpstreamErrorCode; status?: number; path?: string }
  ) {
    super(message, { extensions })
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
  if (response.status === 410) {
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
 * UPSTREAM_ERROR. The original message stays in the gateway log, where the
 * caller already wrote it; it is not repeated to the client because it can
 * carry internal addresses.
 */
export function upstreamFailure(_error: unknown, what: string): UpstreamError {
  return new UpstreamError(`${what} failed upstream`, { code: 'UPSTREAM_ERROR' })
}

export const DESCRIPTION_ANNOTATION = 'kubernetes.io/description'
export const DISPLAY_NAME_ANNOTATION = 'kubernetes.io/display-name'
