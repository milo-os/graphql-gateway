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

export const DESCRIPTION_ANNOTATION = 'kubernetes.io/description'
export const DISPLAY_NAME_ANNOTATION = 'kubernetes.io/display-name'
