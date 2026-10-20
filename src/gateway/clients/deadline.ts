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
 * The deadline covers time-to-headers only, matching what the local fetch
 * duration metric measures. Body reads stay bounded by the apiserver's own
 * request timeout. When the deadline passes the inner request is aborted with
 * an UpstreamTimeoutError as the reason, and the call rejects with that error
 * whether or not the inner fetch honours the signal. A caller-supplied signal
 * still works: its reason wins if it fires first.
 */
export function withDeadline(fetchFn: typeof fetch, { timeoutMs }: DeadlineOptions): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const controller = new AbortController()
    const callerSignal = init?.signal ?? undefined
    const onCallerAbort = () => controller.abort(callerSignal?.reason)

    if (callerSignal?.aborted) {
      controller.abort(callerSignal.reason)
    } else {
      callerSignal?.addEventListener('abort', onCallerAbort, { once: true })
    }

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
