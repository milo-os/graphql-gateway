import { createGatewayRuntime } from '@graphql-hive/gateway'
import { useOpenTelemetry } from '@graphql-hive/plugin-opentelemetry'
import { unifiedGraphHandler } from '@graphql-hive/router-runtime'
import { composeSubgraphs } from '@graphql-mesh/compose-cli'
import { loadOpenAPISubgraph } from '@omnigraph/openapi'
import { env } from '@/gateway/config'
import { getK8sServer, getMTLSFetch } from '@/gateway/auth'
import { log } from '@/shared/utils'
import type { ApiEntry } from '@/shared/types'
import { usePrometheusMetrics } from '@/gateway/metrics/metrics'

/** Response shape from /openapi/v3 endpoint */
interface OpenAPIPathsResponse {
  paths: Record<string, { serverRelativeURL: string }>
}

/**
 * Fetch API list dynamically from the K8s OpenAPI endpoint.
 * Returns paths like "apis/iam.miloapis.com/v1alpha1".
 * Called on each polling interval to pick up real-time updates.
 */
const fetchApisFromOpenAPI = async (): Promise<ApiEntry[]> => {
  const server = getK8sServer()
  const fetchFn = getMTLSFetch()
  const openApiUrl = `${server}/openapi/v3`

  try {
    log.info(`Fetching API list from ${openApiUrl}`)
    const response = await fetchFn(openApiUrl)

    if (!response.ok) {
      throw new Error(`Failed to fetch OpenAPI paths: ${response.status} ${response.statusText}`)
    }

    const data = (await response.json()) as OpenAPIPathsResponse
    const apis = Object.keys(data.paths).map((path) => ({ path }))

    log.info(`Discovered ${apis.length} APIs from OpenAPI endpoint`, {
      apis: apis.map((a) => a.path),
    })

    return apis
  } catch (error) {
    log.error(`Failed to fetch APIs from OpenAPI endpoint: ${error}`)
    throw error
  }
}

/** Logger wrapper compatible with GraphQL Mesh Logger interface */
const noop = () => {}
const meshLogger = {
  log: noop,
  debug: noop,
  info: noop,
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  child: () => meshLogger,
}

/**
 * Derive a unique subgraph name from an API path.
 * e.g., "apis/iam.miloapis.com/v1alpha1" -> "APIS_IAM_MILOAPIS_COM_V1ALPHA1"
 * e.g., "api/v1" -> "API_V1"
 */
const getSubgraphName = (path: string): string => {
  return path
    .replace(/[^a-zA-Z0-9]/g, '_') // Replace non-alphanumeric with underscores
    .replace(/_+/g, '_') // Collapse multiple underscores
    .replace(/^_|_$/g, '') // Trim leading/trailing underscores
    .toUpperCase()
}

/**
 * Create subgraph handlers for each API defined in the configuration.
 * Each subgraph loads its schema from the K8s API server's OpenAPI endpoint.
 */
const getSubgraphs = (apis: ApiEntry[]) => {
  const server = getK8sServer()
  const fetchFn = getMTLSFetch()

  return apis.map(({ path }) => ({
    sourceHandler: loadOpenAPISubgraph(getSubgraphName(path), {
      source: `${server}/openapi/v3/${path}`,
      endpoint: `${server}{context.headers.x-resource-endpoint-prefix}`,
      fetch: fetchFn,
      operationHeaders: {
        Authorization: '{context.headers.authorization}',
      },
    }),
  }))
}

/** Cached supergraph SDL - updated by background polling */
let supergraphSdl: string = ''

/**
 * Compose supergraph by fetching OpenAPI specs at runtime.
 * Called on startup and periodically based on pollingInterval.
 * Fetches API list from OpenAPI endpoint on each call for real-time discovery.
 * Updates the cached supergraphSdl variable.
 */
const composeSupergraph = async (): Promise<string> => {
  log.info('Composing supergraph from OpenAPI specs...')

  // Fetch APIs dynamically from OpenAPI endpoint on each poll
  const apis = await fetchApisFromOpenAPI()
  const handlers = getSubgraphs(apis)
  const subgraphs = await Promise.all(
    handlers.map(async ({ sourceHandler }) => {
      const result = sourceHandler({
        fetch: globalThis.fetch,
        cwd: process.cwd(),
        logger: meshLogger,
      })
      const schema = await result.schema$
      return { name: result.name, schema }
    })
  )

  const result = composeSubgraphs(subgraphs)
  supergraphSdl = result.supergraphSdl
  log.info('Supergraph composed successfully')

  return result.supergraphSdl
}

/**
 * Returns the cached supergraph SDL.
 * Falls back to composing if not ready (safety mechanism).
 */
const getSupergraph = async (): Promise<string> => {
  if (!supergraphSdl) {
    log.warn('Supergraph not ready, composing on demand...')
    return composeSupergraph()
  }
  return supergraphSdl
}

/**
 * Start background polling to refresh the supergraph SDL.
 */
const startPolling = (): void => {
  setInterval(async () => {
    try {
      await composeSupergraph()
    } catch (error) {
      log.error(`Failed to refresh supergraph: ${error}`)
    }
  }, env.pollingInterval)
}

/**
 * Initialize the gateway: compose supergraph eagerly, then start background polling.
 * Must be called before handling requests.
 */
export const initializeGateway = async (): Promise<void> => {
  await composeSupergraph()
  startPolling()
  log.info(`Background polling started (interval: ${env.pollingInterval}ms)`)
}

/**
 * Gateway runtime instance.
 * Uses the cached supergraph SDL which is refreshed by background polling.
 */
export const gateway = createGatewayRuntime({
  supergraph: getSupergraph,
  pollingInterval: env.pollingInterval,
  logging: env.logLevel,
  unifiedGraphHandler,
  plugins: (ctx) => [
    // Uses the SDK configured in telemetry/telemetry.ts via openTelemetrySetup
    useOpenTelemetry({}),
    // Uses the SDK configured in metrics/metrics.ts via usePrometheusMetrics
    usePrometheusMetrics(ctx),
  ],
})
