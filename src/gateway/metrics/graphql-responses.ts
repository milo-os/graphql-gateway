import type { ServerResponse } from 'node:http'
import { Counter, register } from 'prom-client'

const RESPONSES_METRIC = 'graphql_gateway_http_responses_total'

// Counted at the HTTP layer because a request the router runtime rejects
// before execution (a planner that cannot load, a bad supergraph) never
// reaches the Yoga or envelop metrics. Reuse an existing metric so a module
// reload (tests, dev) doesn't throw on duplicate registration.
const responses =
  (register.getSingleMetric(RESPONSES_METRIC) as Counter<'endpoint' | 'code'>) ??
  new Counter({
    name: RESPONSES_METRIC,
    help: 'GraphQL HTTP responses by endpoint kind and status code, counted whatever stage produced them.',
    labelNames: ['endpoint', 'code'],
  })

export type GraphQLEndpointKind = 'root' | 'scoped'

/** Count the response once it has been sent, by its final status code. */
export const countGraphQLResponse = (res: ServerResponse, endpoint: GraphQLEndpointKind): void => {
  res.once('finish', () => responses.inc({ endpoint, code: String(res.statusCode) }))
}
