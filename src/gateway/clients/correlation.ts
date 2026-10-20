import { context, propagation, type TextMapSetter } from '@opentelemetry/api'
import { REQUEST_ID_HEADER, getRequestContext } from '@/shared/request-context'

/**
 * Milo's apiserver stamps this header on the audit event for the call, so a
 * portal request id becomes searchable in Milo's audit log.
 */
export const AUDIT_ID_HEADER = 'audit-id'

const setOnHeaders: TextMapSetter<Headers> = {
  set: (carrier, key, value) => carrier.set(key, value),
}

/**
 * Wraps a fetch so every outbound call carries the inbound request id and the
 * active trace. Hive Gateway already does this for federated subgraph calls;
 * this covers the gateway-local resolvers, which call Milo through their own
 * fetch. Headers the caller set are left alone.
 */
export function withCorrelation(fetchFn: typeof fetch): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined)
    )

    const requestId = getRequestContext()?.requestId
    if (requestId) {
      if (!headers.has(REQUEST_ID_HEADER)) headers.set(REQUEST_ID_HEADER, requestId)
      if (!headers.has(AUDIT_ID_HEADER)) headers.set(AUDIT_ID_HEADER, requestId)
    }

    if (!headers.has('traceparent')) {
      propagation.inject(context.active(), headers, setOnHeaders)
    }

    return fetchFn(input, { ...init, headers })
  }) as typeof fetch
}
