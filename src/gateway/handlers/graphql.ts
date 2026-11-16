import type { IncomingMessage, ServerResponse } from 'node:http'
import { sendJson, parseUrl } from '@/gateway/utils'
import {
  env,
  validParentResources,
  scopedEndpoints,
  SCOPED_RESOURCE_PATTERN,
} from '@/gateway/config'
import { checkCaller } from '@/gateway/auth'
import type { CallerVerdict } from '@/gateway/auth'
import { gateway } from '@/gateway/runtime'
import { log } from '@/shared/utils'
import { countGraphQLResponse } from '@/gateway/metrics/graphql-responses'
import { countCallerCheck } from '@/gateway/metrics/caller-checks'
import type { ScopedMatch, GatewayHandler } from '@/gateway/types'

/**
 * Refuses a request whose token Milo did not accept. The body is a GraphQL
 * error so clients map it like any other, and says nothing about the schema.
 * A token Milo could not check is a 503: the caller may be fine, and retrying
 * can succeed.
 */
const refuseCaller = (res: ServerResponse, verdict: Exclude<CallerVerdict, 'authenticated'>) => {
  if (verdict === 'unavailable') {
    return sendJson(res, 503, {
      errors: [
        { message: 'Could not verify credentials', extensions: { code: 'UPSTREAM_UNAVAILABLE' } },
      ],
    })
  }
  return sendJson(
    res,
    401,
    { errors: [{ message: 'Authentication required', extensions: { code: 'UNAUTHENTICATED' } }] },
    { 'WWW-Authenticate': 'Bearer' }
  )
}

/**
 * Checks the caller's token before anything reaches Hive, so introspection,
 * gateway-local fields and federated fields are all covered. Returns true when
 * the request may go on. AUTH_MODE=log lets a failed check through and logs it.
 */
const admitCaller = async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
  const verdict = await checkCaller(req.headers.authorization)
  if (verdict === 'authenticated') {
    countCallerCheck(verdict, false)
    return true
  }
  const enforced = env.authMode === 'enforce'
  countCallerCheck(verdict, enforced)
  if (enforced) {
    refuseCaller(res, verdict)
    return false
  }
  log.warn('Letting a GraphQL request through without an accepted token (AUTH_MODE=log)', {
    verdict,
  })
  return true
}

/**
 * Parse a scoped URL match into a structured object.
 */
const parseScopedMatch = (match: RegExpExecArray): ScopedMatch => {
  const [, apiGroup, version, kindPlural, resourceName] = match
  return {
    apiGroup,
    version,
    kindPlural,
    kind: kindPlural.replace(/s$/, ''),
    resourceName,
  }
}

/**
 * x-resource-* headers are gateway-owned: the scoped path derives them from
 * the URL, and client-supplied values must never reach request handling.
 */
const RESOURCE_HEADERS = [
  'x-resource-api-group',
  'x-resource-version',
  'x-resource-kind',
  'x-resource-name',
  'x-resource-endpoint-prefix',
] as const

/**
 * Set headers for scoped resource requests.
 * These headers are used by the upstream API to route to the correct resource.
 */
const setScopedHeaders = (req: IncomingMessage, scoped: ScopedMatch): void => {
  req.headers['x-resource-api-group'] = scoped.apiGroup
  req.headers['x-resource-version'] = scoped.version
  req.headers['x-resource-kind'] = scoped.kind
  req.headers['x-resource-name'] = scoped.resourceName
  req.headers['x-resource-endpoint-prefix'] =
    `/apis/${scoped.apiGroup}/${scoped.version}/${scoped.kindPlural}/${scoped.resourceName}/control-plane`
}

/** Delete every gateway-owned x-resource-* header from the request. */
export const clearResourceHeaders = (req: IncomingMessage): void => {
  for (const header of RESOURCE_HEADERS) delete req.headers[header]
}

/** Check if the path is the root GraphQL endpoint */
export const isRootGraphQL = (pathname: string): boolean => {
  return pathname === '/graphql'
}

/** Check if the path is a scoped GraphQL endpoint */
export const isScopedGraphQL = (pathname: string): boolean => {
  return SCOPED_RESOURCE_PATTERN?.test(pathname) === true
}

/** Check if the path is any GraphQL endpoint (root or scoped) */
export const isGraphQLEndpoint = (pathname: string): boolean => {
  return isRootGraphQL(pathname) || isScopedGraphQL(pathname)
}

/**
 * Builds the GraphQL handler (root and scoped paths). It parses the URL,
 * validates scoped resources, and forwards to the gateway. With
 * `requireToken` it first refuses callers whose token Milo does not accept.
 */
const graphQLHandler =
  ({ requireToken }: { readonly requireToken: boolean }): GatewayHandler =>
  async (req, res) => {
    const url = parseUrl(req.url!, req.headers.host!)
    const scopedMatch = SCOPED_RESOURCE_PATTERN?.exec(url.pathname)
    countGraphQLResponse(res, scopedMatch ? 'scoped' : 'root')

    if (requireToken && !(await admitCaller(req, res))) return

    return forwardGraphQL(req, res, scopedMatch)
  }

const forwardGraphQL = async (
  req: IncomingMessage,
  res: ServerResponse,
  scopedMatch: RegExpExecArray | null | undefined
) => {
  if (scopedMatch) {
    const scoped = parseScopedMatch(scopedMatch)
    const lookupKey = `${scoped.apiGroup}/${scoped.version}/${scoped.kind}`

    if (!validParentResources.has(lookupKey)) {
      log.warn(`Invalid parent resource: ${lookupKey}`)
      return sendJson(res, 404, {
        error: 'Invalid parent resource',
        message: `No APIs are scoped to ${lookupKey}`,
        validEndpoints: scopedEndpoints,
      })
    }

    log.info(`Scoped request: ${scoped.kind}/${scoped.resourceName}`)
    setScopedHeaders(req, scoped)
  } else {
    log.info('Root GraphQL request')
    clearResourceHeaders(req)
  }

  return gateway(req, res)
}

/** GraphQL on the routed port: every request needs a token Milo accepts. */
export const handleGraphQL: GatewayHandler = graphQLHandler({ requireToken: true })

/**
 * GraphQL on the internal port, which no HTTPRoute targets: no token check.
 * It serves in-cluster callers that send no token, such as the Zitadel
 * actions receiver calling geolocateIP and parseUserAgent.
 */
export const handleInternalGraphQL: GatewayHandler = graphQLHandler({ requireToken: false })
