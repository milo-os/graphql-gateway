import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'

export const REQUEST_ID_HEADER = 'x-request-id'

export interface RequestContext {
  /** Id of the inbound request: the portal's X-Request-ID, or one the gateway generated. */
  requestId: string
  /**
   * Gateway-generated id sent to Milo as Audit-ID. Never the inbound value: a
   * caller could otherwise choose an id that collides with another request's
   * audit events. The gateway log line carries both, which is the link.
   */
  auditId: string
}

const storage = new AsyncLocalStorage<RequestContext>()

/** Runs `fn` with `ctx` visible to everything it awaits, including upstream fetches and log calls. */
export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn)
}

/** The context of the request currently being served, or undefined outside of one. */
export function getRequestContext(): RequestContext | undefined {
  return storage.getStore()
}

type HeaderBag = Record<string, string | string[] | undefined> | Headers

/**
 * Shape an inbound id must have to be trusted. It is copied onto upstream
 * headers, including Milo's Audit-ID, so anything else is replaced with a
 * generated id rather than forwarded.
 */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/

/**
 * The inbound request id, read from the X-Request-ID header, or generated
 * when the header is absent or not a plain token.
 */
export function requestIdFromHeaders(headers: HeaderBag): string {
  const raw =
    headers instanceof Headers ? headers.get(REQUEST_ID_HEADER) : headers[REQUEST_ID_HEADER]
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? ''
  return REQUEST_ID_PATTERN.test(value) ? value : randomUUID()
}

/** The context for one inbound request: its (validated) request id and a fresh audit id. */
export function createRequestContext(headers: HeaderBag): RequestContext {
  return { requestId: requestIdFromHeaders(headers), auditId: randomUUID() }
}
