import type { IncomingMessage, ServerResponse } from 'node:http'
import { sendJson } from '@/gateway/utils'
import { isInitialized } from '@/gateway/auth'
import { isSupergraphReady } from '@/gateway/runtime'

const HEALTH_PATHS = new Set(['/health', '/healthz', '/healthcheck'])

export const isHealthCheck = (pathname: string): boolean => {
  return HEALTH_PATHS.has(pathname)
}

/** Liveness. The process is alive once the HTTPS server accepts requests. */
export const handleHealthCheck = (_req: IncomingMessage, res: ServerResponse): void => {
  sendJson(res, 200, { status: 'ok' })
}

export const isReadinessCheck = (pathname: string): boolean => {
  return pathname === '/readiness'
}

/** Readiness: auth is initialised and the committed SDL is loaded. */
export const handleReadinessCheck = (_req: IncomingMessage, res: ServerResponse): void => {
  if (!isInitialized()) {
    sendJson(res, 503, { status: 'not ready', reason: 'K8s auth not initialized' })
  } else if (!isSupergraphReady()) {
    sendJson(res, 503, { status: 'not ready', reason: 'Supergraph snapshot not loaded' })
  } else {
    sendJson(res, 200, { status: 'ready' })
  }
}
