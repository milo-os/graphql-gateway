import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createGatewayRuntime } from '@graphql-hive/gateway'
import { register } from 'prom-client'
import { countGraphQLResponse } from './graphql-responses'

const responsesWithCode = async (code: string): Promise<number> => {
  const metric = await register.getSingleMetric('graphql_gateway_http_responses_total')?.get()
  return (metric?.values ?? [])
    .filter((v) => v.labels.code === code && v.labels.endpoint === 'root')
    .reduce((sum, v) => sum + v.value, 0)
}

describe('countGraphQLResponse', () => {
  let server: Server
  let url: string

  beforeAll(async () => {
    const gateway = createGatewayRuntime({
      supergraph: readFileSync(resolve(process.cwd(), 'supergraph/supergraph.graphql'), 'utf8'),
      logging: false,
      unifiedGraphHandler: () => {
        throw new Error('Cannot find native binding')
      },
    })
    server = createServer((req, res) => {
      countGraphQLResponse(res, 'root')
      void gateway(req, res)
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/graphql`
  })

  afterAll(async () => {
    await new Promise((done) => server.close(done))
  })

  it('counts a request the router runtime rejects before execution', async () => {
    const before = await responsesWithCode('500')

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ getCoreAPIVersions { __typename } }' }),
    })
    await res.text()

    expect(res.status).toBe(500)
    await expect.poll(() => responsesWithCode('500')).toBe(before + 1)
  })
})
