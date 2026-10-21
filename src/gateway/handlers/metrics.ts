import type { IncomingMessage, ServerResponse } from 'node:http'
import { gateway } from '@/gateway/runtime'
import { clearResourceHeaders } from './graphql'

const METRICS_PATHS = new Set(['/metrics'])

export const isMetrics = (pathname: string): boolean => {
  return METRICS_PATHS.has(pathname)
}

export const handleMetrics = (req: IncomingMessage, res: ServerResponse) => {
  clearResourceHeaders(req)
  return gateway(req, res)
}
