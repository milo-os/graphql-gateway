import { createServer } from 'node:https'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { sendJson, parseUrl } from './utils/'
import { availableEndpoints, env } from './config'
import { log } from '@/shared/utils'
import {
  REQUEST_ID_HEADER,
  requestIdFromHeaders,
  runWithRequestContext,
} from '@/shared/request-context'
import {
  isHealthCheck,
  handleHealthCheck,
  isReadinessCheck,
  handleReadinessCheck,
  isGraphQLEndpoint,
  handleGraphQL,
  isMetrics,
  handleMetrics,
} from './handlers'
import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * Load TLS certificates from the configured directory.
 * Panics if CERT_DIR is not set or certificates don't exist.
 */
const loadTlsOptions = () => {
  const { certDir } = env
  if (!certDir) {
    log.error('CERT_DIR environment variable is required for HTTPS')
    process.exit(1)
  }

  const certPath = join(certDir, 'tls.crt')
  const keyPath = join(certDir, 'tls.key')

  if (!existsSync(certPath)) {
    log.error(`TLS certificate not found: ${certPath}`)
    process.exit(1)
  }

  if (!existsSync(keyPath)) {
    log.error(`TLS key not found: ${keyPath}`)
    process.exit(1)
  }

  log.info(`Loading TLS certificates from ${certDir}`)
  try {
    return {
      cert: readFileSync(certPath),
      key: readFileSync(keyPath),
    }
  } catch (error) {
    log.error(`Failed to read TLS certificates: ${error}`)
    process.exit(1)
  }
}

export const createGatewayServer = () => {
  const tlsOptions = loadTlsOptions()

  const dispatch = async (req: IncomingMessage, res: ServerResponse) => {
    const url = parseUrl(req.url!, req.headers.host!)
    const { pathname } = url

    const logMessage = `${req.method} ${pathname}`

    // GraphQL endpoints (root and scoped)
    if (isGraphQLEndpoint(pathname)) {
      log.info(logMessage)
      return handleGraphQL(req, res)
    }

    // Health check endpoints (liveness) - don't log these to avoid noise
    if (isHealthCheck(pathname)) {
      log.debug(logMessage)
      return handleHealthCheck(req, res)
    }

    // Readiness endpoint - don't log these to avoid noise
    if (isReadinessCheck(pathname)) {
      log.debug(logMessage)
      return handleReadinessCheck(req, res)
    }

    // Metrics endpoint
    if (isMetrics(pathname)) {
      log.debug(logMessage)
      return handleMetrics(req, res)
    }

    // 404 for everything else
    log.warn(`Not found: ${pathname}`)
    sendJson(res, 404, {
      error: 'Not Found',
      availableEndpoints,
    })
  }

  // Every request runs inside a request context so log lines and upstream
  // calls made anywhere below carry the portal's X-Request-ID. The header is
  // written back onto the request so Hive Gateway's own request-id plugin
  // picks up the same value instead of generating a second one.
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const requestId = requestIdFromHeaders(req.headers)
    req.headers[REQUEST_ID_HEADER] = requestId
    return runWithRequestContext({ requestId }, () => dispatch(req, res))
  }

  log.info('Starting server with HTTPS')
  return createServer(tlsOptions, handler)
}
