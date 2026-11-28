import { GraphQLError } from 'graphql'
import type { ExecutionResult } from 'graphql'
import { describe, expect, it } from 'vitest'
import { sanitizeExtensions, sanitizeResult, useSanitizedErrors } from './sanitize-errors'

const downstream = () =>
  new GraphQLError('Upstream HTTP Error: 403, Could not invoke operation GET /apis/x', {
    path: ['readThing'],
    extensions: {
      code: 'DOWNSTREAM_SERVICE_ERROR',
      serviceName: 'APIS_X',
      request: { url: 'https://internal.example:6443/apis/x', method: 'GET' },
      response: {
        status: 403,
        statusText: 'Forbidden',
        headers: { 'audit-id': 'abc' },
        body: { kind: 'Status', message: 'forbidden' },
      },
    },
  })

describe('sanitizeExtensions', () => {
  it('keeps the code and the upstream status, and nothing about the upstream call', () => {
    expect(sanitizeExtensions(downstream().extensions)).toEqual({
      code: 'DOWNSTREAM_SERVICE_ERROR',
      status: 403,
    })
  })

  it("keeps the gateway's own extensions as they are", () => {
    const own = { code: 'UPSTREAM_TIMEOUT', timeoutMs: 10_000, path: '/apis/x', status: 504 }
    expect(sanitizeExtensions(own)).toEqual(own)
  })

  it('does not overwrite a status the error already set', () => {
    expect(sanitizeExtensions({ code: 'X', status: 502, response: { status: 403 } })).toEqual({
      code: 'X',
      status: 502,
    })
  })
})

describe('sanitizeResult', () => {
  it('strips upstream details but keeps the message, path and data', () => {
    const result: ExecutionResult = { data: { readThing: null }, errors: [downstream()] }

    const clean = sanitizeResult(result)

    expect(clean.data).toEqual({ readThing: null })
    expect(clean.errors?.[0]).toBeInstanceOf(GraphQLError)
    expect(JSON.parse(JSON.stringify(clean.errors?.[0]))).toEqual({
      message: 'Upstream HTTP Error: 403, Could not invoke operation GET /apis/x',
      path: ['readThing'],
      extensions: { code: 'DOWNSTREAM_SERVICE_ERROR', status: 403 },
    })
  })

  it('cleans plain error objects too', () => {
    const result = {
      errors: [{ message: 'boom', extensions: { code: 'X', request: { url: 'https://in' } } }],
    } as unknown as ExecutionResult

    expect(sanitizeResult(result).errors).toEqual([{ message: 'boom', extensions: { code: 'X' } }])
  })

  it('returns a result with nothing to strip unchanged', () => {
    const result: ExecutionResult = {
      data: null,
      errors: [new GraphQLError('nope', { extensions: { code: 'FORBIDDEN', status: 403 } })],
    }
    expect(sanitizeResult(result)).toBe(result)
  })
})

describe('useSanitizedErrors', () => {
  const process = (result: unknown) => {
    let out: unknown
    const plugin = useSanitizedErrors()
    plugin.onResultProcess!({
      result,
      setResult: (r: unknown) => (out = r),
    } as never)
    return out
  }

  it('cleans a single result', () => {
    const out = process({ errors: [downstream()] }) as ExecutionResult
    expect(out.errors?.[0].extensions).toEqual({ code: 'DOWNSTREAM_SERVICE_ERROR', status: 403 })
  })

  it('cleans every result of a batch', () => {
    const out = process([{ errors: [downstream()] }, { data: { ok: true } }]) as ExecutionResult[]
    expect(out[0].errors?.[0].extensions).toEqual({ code: 'DOWNSTREAM_SERVICE_ERROR', status: 403 })
    expect(out[1]).toEqual({ data: { ok: true } })
  })

  it('cleans each result of a stream', async () => {
    async function* stream() {
      yield { errors: [downstream()] } as ExecutionResult
    }
    const out = process(stream()) as AsyncIterable<ExecutionResult>
    const results: ExecutionResult[] = []
    for await (const r of out) results.push(r)
    expect(results[0].errors?.[0].extensions).toEqual({
      code: 'DOWNSTREAM_SERVICE_ERROR',
      status: 403,
    })
  })
})
