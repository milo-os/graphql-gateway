import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createGatewayRuntime } from '@graphql-hive/gateway'
import { unifiedGraphHandler } from '@graphql-hive/router-runtime'
import { composeServices } from '@theguild/federation-composition'
import { createSchema, createYoga } from 'graphql-yoga'
import { GraphQLError, parse } from 'graphql'
import { register } from 'prom-client'
import { usePrometheusMetrics } from './metrics'

const listen = async (server: Server): Promise<string> => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/graphql`
}

const subgraphErrors = async (authenticated: string): Promise<number> => {
  const metric = await register.getSingleMetric('graphql_gateway_subgraph_execute_errors')?.get()
  return (metric?.values ?? [])
    .filter((v) => v.labels.authenticated === authenticated)
    .reduce((sum, v) => sum + v.value, 0)
}

describe('usePrometheusMetrics', () => {
  let upstream: Server
  let gatewayServer: Server
  let url: string

  beforeAll(async () => {
    upstream = createServer(
      createYoga({
        schema: createSchema({
          typeDefs: 'type Query { forbidden: String }',
          resolvers: {
            Query: {
              forbidden: () => {
                throw new GraphQLError('forbidden')
              },
            },
          },
        }),
      })
    )
    const { supergraphSdl, errors } = composeServices([
      {
        name: 'UPSTREAM',
        url: await listen(upstream),
        typeDefs: parse(
          'extend schema @link(url: "https://specs.apollo.dev/federation/v2.3", import: []) type Query { forbidden: String }'
        ),
      },
    ])
    if (!supergraphSdl) throw new Error(`supergraph composition failed: ${JSON.stringify(errors)}`)
    const gateway = createGatewayRuntime({
      supergraph: supergraphSdl,
      unifiedGraphHandler,
      logging: false,
      plugins: (ctx) => [usePrometheusMetrics(ctx)],
    })
    gatewayServer = createServer(gateway)
    url = await listen(gatewayServer)
  })

  afterAll(async () => {
    await new Promise((done) => gatewayServer.close(done))
    await new Promise((done) => upstream.close(done))
  })

  const query = (headers: Record<string, string>) =>
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ query: '{ forbidden }' }),
    }).then((res) => res.text())

  it('labels subgraph errors from callers without credentials as unauthenticated', async () => {
    const before = await subgraphErrors('false')
    await query({})
    await expect.poll(() => subgraphErrors('false')).toBe(before + 1)
  })

  it('labels subgraph errors from callers with credentials as authenticated', async () => {
    const before = await subgraphErrors('true')
    await query({ authorization: 'Bearer token' })
    await expect.poll(() => subgraphErrors('true')).toBe(before + 1)
  })

  it('has a request duration bucket at the slow-operation threshold', async () => {
    await query({})
    const metric = await register.getSingleMetric('graphql_envelop_request_duration')?.get()
    const bounds = new Set((metric?.values ?? []).map((v) => v.labels.le))
    expect(bounds).toContain(2)
  })
})
