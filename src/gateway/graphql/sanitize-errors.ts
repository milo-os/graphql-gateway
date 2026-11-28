import { GraphQLError } from 'graphql'
import type { ExecutionResult, GraphQLFormattedError } from 'graphql'
import { createGraphQLError } from '@graphql-tools/utils'
import type { Plugin } from 'graphql-yoga'

/**
 * Error extensions clients may see. `code` and `status` are what the portals
 * map errors by; `path` and `timeoutMs` are set by the gateway's own
 * resolvers; `http` is Yoga's, which it uses for the response status and
 * strips before sending.
 *
 * Everything else is dropped. In particular the federated REST transport puts
 * the upstream `request` (URL, method) and `response` (headers, full body) on
 * DOWNSTREAM_SERVICE_ERROR, which would hand internal hostnames and server
 * details to any caller.
 */
const KEPT_EXTENSIONS: ReadonlySet<string> = new Set([
  'code',
  'status',
  'path',
  'timeoutMs',
  'http',
])

type Extensions = Readonly<Record<string, unknown>>

const upstreamStatus = (extensions: Extensions): number | undefined => {
  const status = (extensions.response as { status?: unknown } | undefined)?.status
  return typeof status === 'number' ? status : undefined
}

/**
 * Keeps only the allowed extensions. An upstream HTTP status that only lived
 * on the dropped `response` is kept as `status`, so clients can still tell a
 * 403 from a 404.
 */
export const sanitizeExtensions = (extensions: Extensions): Record<string, unknown> => {
  const kept = Object.fromEntries(
    Object.entries(extensions).filter(([key]) => KEPT_EXTENSIONS.has(key))
  )
  const status = upstreamStatus(extensions)
  return kept.status === undefined && status !== undefined ? { ...kept, status } : kept
}

type ResultError = GraphQLError | GraphQLFormattedError

const needsSanitizing = (error: ResultError): boolean =>
  Object.keys(error.extensions ?? {}).some((key) => !KEPT_EXTENSIONS.has(key))

const sanitizeError = (error: ResultError): ResultError => {
  if (!needsSanitizing(error)) return error
  const extensions = sanitizeExtensions(error.extensions ?? {})
  if (error instanceof GraphQLError) {
    return createGraphQLError(error.message, {
      nodes: error.nodes,
      source: error.source,
      positions: error.positions,
      path: error.path,
      originalError: error.originalError ?? undefined,
      extensions,
    })
  }
  return { ...error, extensions }
}

/** Returns the result with every error's extensions cut down to the allowed set. */
export const sanitizeResult = <R extends ExecutionResult>(result: R): R =>
  result.errors?.some(needsSanitizing)
    ? { ...result, errors: result.errors.map(sanitizeError) as R['errors'] }
    : result

async function* sanitizeStream(
  stream: AsyncIterable<ExecutionResult>
): AsyncGenerator<ExecutionResult> {
  for await (const result of stream) yield sanitizeResult(result)
}

/**
 * Cuts error extensions down to what clients need, on the final result of
 * every operation (local, federated and introspection alike), just before
 * Yoga serialises it.
 */
export const useSanitizedErrors = (): Plugin => ({
  onResultProcess({ result, setResult }) {
    if (Array.isArray(result)) return setResult(result.map(sanitizeResult))
    if (Symbol.asyncIterator in result) return setResult(sanitizeStream(result))
    setResult(sanitizeResult(result))
  },
})
