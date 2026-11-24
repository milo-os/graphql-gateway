import type { GatewayConfigContext } from '@graphql-hive/gateway'
import usePrometheus, {
  createCounter,
  createHistogram,
  type PrometheusPluginOptions,
} from '@graphql-mesh/plugin-prometheus'
import { register } from 'prom-client'

type MetricsConfig = Exclude<PrometheusPluginOptions['metrics'], boolean | undefined>
type SubgraphErrorsOption = NonNullable<MetricsConfig['graphql_gateway_subgraph_execute_errors']>
type RequestDurationOption = NonNullable<MetricsConfig['graphql_envelop_request_duration']>
export type SubgraphExecutePayload = Parameters<
  Extract<SubgraphErrorsOption, { fillLabelsFn: unknown }>['fillLabelsFn']
>[0]

type HeaderCarrier = {
  request?: { headers?: { get?: (name: string) => string | null } }
  headers?: Record<string, string | undefined>
}

export function isAuthenticated({ executionRequest }: SubgraphExecutePayload): boolean {
  const context = executionRequest.context as HeaderCarrier | undefined
  return Boolean(
    context?.request?.headers?.get?.('authorization') ||
    context?.headers?.authorization ||
    context?.headers?.Authorization
  )
}

export function subgraphErrorLabels(payload: SubgraphExecutePayload) {
  return {
    subgraphName: payload.subgraphName,
    operationName: payload.executionRequest.operationName || 'Anonymous',
    operationType: payload.executionRequest.operationType || 'query',
    authenticated: String(isAuthenticated(payload)),
  }
}

const subgraphExecuteErrors = (): SubgraphErrorsOption =>
  createCounter({
    registry: register,
    counter: {
      name: 'graphql_gateway_subgraph_execute_errors',
      help: 'Number of errors on subgraph execution, by whether the caller sent credentials',
      labelNames: ['subgraphName', 'operationName', 'operationType', 'authenticated'],
    },
    fillLabelsFn: subgraphErrorLabels,
    phases: ['subgraphExecute'],
  })

const requestDuration = (): RequestDurationOption =>
  createHistogram({
    registry: register,
    histogram: {
      name: 'graphql_envelop_request_duration',
      help: 'Time spent on running the GraphQL operation from parse to execute',
      labelNames: ['operationType', 'operationName'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 2.5, 5, 10],
    },
    fillLabelsFn: (params) => ({
      operationType: params.operationType ?? '',
      operationName: params.operationName ?? '',
    }),
    phases: ['execute', 'subscribe'],
  })

export function usePrometheusMetrics(ctx: GatewayConfigContext) {
  return usePrometheus({
    ...ctx,
    metrics: {
      graphql_gateway_fetch_duration: true,
      graphql_gateway_subgraph_execute_duration: true,
      graphql_gateway_subgraph_execute_errors: subgraphExecuteErrors(),
      graphql_envelop_deprecated_field: true,
      graphql_envelop_request: true,
      graphql_envelop_request_duration: requestDuration(),
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
