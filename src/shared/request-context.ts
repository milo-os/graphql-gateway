import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'

export const REQUEST_ID_HEADER = 'x-request-id'

export interface RequestContext {
  /** Id of the inbound request: the portal's X-Request-ID, or one the gateway generated. */
  requestId: string
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

/** The inbound request id, read from the X-Request-ID header or generated when the header is absent. */
export function requestIdFromHeaders(headers: HeaderBag): string {
  const raw =
    headers instanceof Headers ? headers.get(REQUEST_ID_HEADER) : headers[REQUEST_ID_HEADER]
  const value = Array.isArray(raw) ? raw[0] : raw
  return value?.trim() || randomUUID()
}
