import { GraphQLError } from 'graphql'

export interface DeadlineOptions {
  /** Milliseconds allowed for response headers to arrive. */
  timeoutMs: number
}

const pathOf = (url: string): string => {
  try {
    return new URL(url).pathname
  } catch {
    return url
  }
}

const urlOf = (input: RequestInfo | URL): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url

/**
 * Thrown when an upstream call does not return response headers before its
 * deadline. It is a GraphQLError so resolvers can let it propagate and the
 * client sees `extensions.code = UPSTREAM_TIMEOUT` instead of an empty list.
 */
export class UpstreamTimeoutError extends GraphQLError {
  constructor(url: string, timeoutMs: number) {
    const path = pathOf(url)
    super(`Upstream request to ${path} did not respond within ${timeoutMs}ms`, {
      extensions: { code: 'UPSTREAM_TIMEOUT', timeoutMs, path },
    })
    this.name = 'UpstreamTimeoutError'
  }
}

/**
 * Wraps a fetch so every call has a deadline for response headers.
 *
 * On the undici path the deadline covers time-to-headers, matching what the
 * local fetch duration metric measures, and body reads stay bounded by the
 * apiserver's own request timeout. The mTLS fetch in k8s.ts buffers the whole
 * body before it resolves, so there the deadline covers the full exchange.
 * When the deadline passes the inner request is aborted with an
 * UpstreamTimeoutError as the reason, and the call rejects with that error
 * whether or not the inner fetch honours the signal. A caller-supplied signal
 * (on init, or carried by a Request input) still works: its reason wins if it
 * fires first, and a signal that is already aborted short-circuits the call.
 */
export function withDeadline(fetchFn: typeof fetch, { timeoutMs }: DeadlineOptions): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
    if (callerSignal?.aborted) {
      return Promise.reject(callerSignal.reason)
    }

    const controller = new AbortController()
    const onCallerAbort = () => controller.abort(callerSignal?.reason)
    callerSignal?.addEventListener('abort', onCallerAbort, { once: true })

    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new UpstreamTimeoutError(urlOf(input), timeoutMs)
        controller.abort(error)
        reject(error)
      }, timeoutMs)
    })

    const cleanup = () => {
      clearTimeout(timer)
      callerSignal?.removeEventListener('abort', onCallerAbort)
    }

    return Promise.race([fetchFn(input, { ...init, signal: controller.signal }), deadline]).finally(
      cleanup
    )
  }) as typeof fetch
}
