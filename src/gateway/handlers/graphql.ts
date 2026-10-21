import type { IncomingMessage } from 'node:http'
import { sendJson, parseUrl } from '@/gateway/utils'
import { validParentResources, scopedEndpoints, SCOPED_RESOURCE_PATTERN } from '@/gateway/config'
import { gateway } from '@/gateway/runtime'
import { log } from '@/shared/utils'
import type { ScopedMatch, GatewayHandler } from '@/gateway/types'

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
 * Handle GraphQL requests (both root and scoped).
 * Parses the URL, validates scoped resources, and forwards to the gateway.
 */
export const handleGraphQL: GatewayHandler = async (req, res) => {
  const url = parseUrl(req.url!, req.headers.host!)
  const scopedMatch = SCOPED_RESOURCE_PATTERN?.exec(url.pathname)

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
