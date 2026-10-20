import type { IncomingMessage, ServerResponse } from 'node:http'
import { sendJson } from '@/gateway/utils'
import { isInitialized } from '@/gateway/auth'
import { hasCompositionGivenUp, isSupergraphReady } from '@/gateway/runtime'

const HEALTH_PATHS = new Set(['/health', '/healthz', '/healthcheck'])

export const isHealthCheck = (pathname: string): boolean => {
  return HEALTH_PATHS.has(pathname)
}

/**
 * Liveness. Fails only when the composition worker restart schedule is
 * exhausted: a failing readiness probe alone would leave the pod running
 * forever with no worker, so this is what makes the kubelet restart it.
 */
export const handleHealthCheck = (_req: IncomingMessage, res: ServerResponse): void => {
  if (hasCompositionGivenUp()) {
    sendJson(res, 503, { status: 'unhealthy', reason: 'Composition worker gave up restarting' })
    return
  }
  sendJson(res, 200, { status: 'ok' })
}

export const isReadinessCheck = (pathname: string): boolean => {
  return pathname === '/readiness'
}

export const handleReadinessCheck = (_req: IncomingMessage, res: ServerResponse): void => {
  if (!isInitialized()) {
    sendJson(res, 503, { status: 'not ready', reason: 'K8s auth not initialized' })
  } else if (hasCompositionGivenUp()) {
    sendJson(res, 503, { status: 'not ready', reason: 'Composition worker gave up restarting' })
  } else if (!isSupergraphReady()) {
    sendJson(res, 503, { status: 'not ready', reason: 'Supergraph not yet composed' })
  } else {
    sendJson(res, 200, { status: 'ready' })
  }
}
