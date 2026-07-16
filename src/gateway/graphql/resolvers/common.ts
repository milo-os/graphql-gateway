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

export const DESCRIPTION_ANNOTATION = 'kubernetes.io/description'
export const DISPLAY_NAME_ANNOTATION = 'kubernetes.io/display-name'
