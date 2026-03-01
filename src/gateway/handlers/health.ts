import type { IncomingMessage, ServerResponse } from 'node:http'
import { sendJson } from '@/gateway/utils'
import { isInitialized } from '@/gateway/auth'

const HEALTH_PATHS = new Set(['/health', '/healthz', '/healthcheck'])

export const isHealthCheck = (pathname: string): boolean => {
  return HEALTH_PATHS.has(pathname)
}

export const handleHealthCheck = (_req: IncomingMessage, res: ServerResponse): void => {
  sendJson(res, 200, { status: 'ok' })
}

export const isReadinessCheck = (pathname: string): boolean => {
  return pathname === '/readiness'
}

export const handleReadinessCheck = (_req: IncomingMessage, res: ServerResponse): void => {
  if (isInitialized()) {
    sendJson(res, 200, { status: 'ready' })
  } else {
    sendJson(res, 503, { status: 'not ready', reason: 'K8s auth not initialized' })
  }
}
