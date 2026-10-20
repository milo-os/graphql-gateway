import { context, propagation, type TextMapSetter } from '@opentelemetry/api'
import { REQUEST_ID_HEADER, getRequestContext } from '@/shared/request-context'

/**
 * Milo's apiserver stamps this header on the audit event for the call. The
 * value is the gateway-generated audit id from the request context, logged
 * next to the portal's request id, so an audit event can be traced back to a
 * portal request without letting a caller pick the audit id.
 */
export const AUDIT_ID_HEADER = 'audit-id'

const setOnHeaders: TextMapSetter<Headers> = {
  set: (carrier, key, value) => carrier.set(key, value),
}

/**
 * Wraps a fetch so every outbound call carries the request id, the audit id
 * and the active trace. Hive Gateway already sets x-request-id on federated
 * subgraph calls (to the same value, since the server writes it back onto the
 * inbound request); this covers the gateway-local resolvers too and adds the
 * audit id. The two correlation headers always come from the request context
 * so a resolver cannot forward a client-chosen value by accident. Other
 * caller headers are left alone.
 */
export function withCorrelation(fetchFn: typeof fetch): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined)
    )

    const ctx = getRequestContext()
    if (ctx) {
      headers.set(REQUEST_ID_HEADER, ctx.requestId)
      headers.set(AUDIT_ID_HEADER, ctx.auditId)
    }

    if (!headers.has('traceparent')) {
      propagation.inject(context.active(), headers, setOnHeaders)
    }

    return fetchFn(input, { ...init, headers })
  }) as typeof fetch
}
