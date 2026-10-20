import { afterEach, describe, expect, it, vi } from 'vitest'
import { context, trace } from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { runWithRequestContext } from '@/shared/request-context'
import { log } from './logger'

describe('log', () => {
  afterEach(() => vi.restoreAllMocks())

  it('appends the request id to the data payload inside a request', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})

    runWithRequestContext({ requestId: 'req-7', auditId: 'a-7' }, () => log.info('hello', { a: 1 }))

    expect(info).toHaveBeenCalledTimes(1)
    const line = info.mock.calls[0]![0] as string
    expect(line).toMatch(/\[INFO\] hello \{"requestId":"req-7","auditId":"a-7","a":1\}$/)
  })

  it('adds a data payload for the request id even when the caller passed none', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    runWithRequestContext({ requestId: 'req-8', auditId: 'a-8' }, () => log.warn('careful'))

    expect(warn.mock.calls[0]![0]).toMatch(
      /\[WARN\] careful \{"requestId":"req-8","auditId":"a-8"\}$/
    )
  })

  it('adds the active trace id next to the request id', () => {
    const contextManager = new AsyncLocalStorageContextManager()
    context.setGlobalContextManager(contextManager.enable())
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const ctx = trace.setSpanContext(context.active(), {
      traceId: '0af7651916cd43dd8448eb211c80319c',
      spanId: 'b7ad6b7169203331',
      traceFlags: 1,
    })

    try {
      runWithRequestContext({ requestId: 'req-9', auditId: 'a-9' }, () =>
        context.with(ctx, () => log.info('traced'))
      )
    } finally {
      context.disable()
    }

    expect(info.mock.calls[0]![0]).toMatch(
      /\[INFO\] traced \{"requestId":"req-9","auditId":"a-9","traceId":"0af7651916cd43dd8448eb211c80319c"\}$/
    )
  })

  it('lets a caller-supplied requestId win over the ambient one', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})

    runWithRequestContext({ requestId: 'req-10', auditId: 'a-10' }, () =>
      log.info('batch', { requestId: 'job-1' })
    )

    expect(info.mock.calls[0]![0]).toMatch(/"requestId":"job-1"/)
    expect(info.mock.calls[0]![0]).not.toMatch(/req-10/)
  })

  it('keeps the plain format outside of a request', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    log.error('boom', { code: 1 })

    expect(error.mock.calls[0]![0]).toMatch(/\[ERROR\] boom \{"code":1\}$/)
  })
})
