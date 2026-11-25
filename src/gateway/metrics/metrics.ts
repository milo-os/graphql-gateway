import type { GatewayConfigContext } from '@graphql-hive/gateway'
import usePrometheus from '@graphql-mesh/plugin-prometheus'

// The explicit return type keeps declaration output from naming packages that
// pnpm keeps out of the top-level node_modules (TS2742).
export function usePrometheusMetrics(ctx: GatewayConfigContext): ReturnType<typeof usePrometheus> {
  return usePrometheus({
    ...ctx,
    metrics: {
      graphql_gateway_fetch_duration: true,
      graphql_gateway_subgraph_execute_duration: true,
      graphql_gateway_subgraph_execute_errors: true,
      graphql_envelop_deprecated_field: true,
      graphql_envelop_request: true,
      graphql_envelop_request_duration: true,
      graphql_envelop_request_time_summary: true,
      graphql_envelop_phase_parse: true,
      graphql_envelop_phase_validate: true,
      graphql_envelop_phase_context: true,
      graphql_envelop_error_result: true,
      graphql_envelop_phase_execute: true,
      graphql_envelop_phase_subscribe: true,
      graphql_envelop_schema_change: true,
      graphql_yoga_http_duration: true,
    },
  })
}
