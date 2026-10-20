import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  REQUEST_ID_HEADER,
  createRequestContext,
  runWithRequestContext,
} from '@/shared/request-context'

type HttpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void

/**
 * Runs every request inside a request context so log lines and upstream calls
 * made anywhere below carry the portal's X-Request-ID. The validated id is
 * written back onto the request so Hive Gateway's own request-id plugin picks
 * up the same value instead of generating a second one, and echoed on the
 * response so non-GraphQL responses (health, metrics, 404) can be correlated.
 */
export function withRequestContext(handler: HttpHandler): HttpHandler {
  return (req, res) => {
    const context = createRequestContext(req.headers)
    req.headers[REQUEST_ID_HEADER] = context.requestId
    res.setHeader(REQUEST_ID_HEADER, context.requestId)
    return runWithRequestContext(context, () => handler(req, res))
  }
}
