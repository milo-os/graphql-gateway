import { createGatewayRuntime } from '@graphql-hive/gateway'
import { useOpenTelemetry } from '@graphql-hive/plugin-opentelemetry'
import { unifiedGraphHandler } from '@graphql-hive/router-runtime'
import { env } from '@/gateway/config'
import { usePrometheusMetrics } from '@/gateway/metrics/metrics'
import {
  useGatewayLocalSchema,
  useInternalPortAllowlist,
  useSanitizedErrors,
} from '@/gateway/graphql'
import { getSupergraph } from './supergraph'

export { initializeGateway, isSupergraphReady } from './supergraph'

/**
 * Gateway runtime instance.
 * Uses the SDL committed under `supergraph/`, loaded once at boot.
 */
export const gateway = createGatewayRuntime({
  supergraph: getSupergraph,
  logging: env.logLevel,
  unifiedGraphHandler,
  plugins: (ctx) => [
    // Uses the SDK configured in telemetry/telemetry.ts via openTelemetrySetup
    useOpenTelemetry({}),
    // Uses the SDK configured in metrics/metrics.ts via usePrometheusMetrics
    usePrometheusMetrics(ctx),
    // Refuses everything but geolocateIP and parseUserAgent on the internal
    // port, before anything executes.
    useInternalPortAllowlist(),
    // Adds gateway-local fields (parseUserAgent, geolocateIP) to the schema.
    // Required because @graphql-hive/router-runtime ignores additionalTypeDefs
    // / additionalResolvers — see ./plugin.ts.
    useGatewayLocalSchema(),
    // Drops upstream request/response details from error extensions.
    useSanitizedErrors(),
  ],
})
