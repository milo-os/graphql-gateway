/**
 * Supergraph composition from a Kubernetes OpenAPI v3 discovery document.
 *
 * This module is shared by the snapshot script (`scripts/compose-supergraph.ts`)
 * and its tests. It is deliberately free of `@/` path aliases so it can be run
 * directly by tsx outside the gateway bundle.
 *
 * The runtime no longer composes: it loads the SDL committed by the snapshot
 * workflow. Composition lives here so the CI job and any manual run follow
 * exactly the same load, align and merge steps.
 */
import { getUnifiedGraphGracefully } from '@graphql-mesh/compose-cli'
import { loadOpenAPISubgraph } from '@omnigraph/openapi'
import { alignSharedTypes } from './align-shared-types'
import { OPENAPI_DISCOVERY_PATH } from './supergraph-snapshot'

/**
 * Maximum number of OpenAPI spec fetches to run concurrently.
 *
 * Every k8s API group/version embeds its own copy of the apimachinery types,
 * and the discovery document lists dozens of specs. Fetching them all at once
 * saturates the API server and makes a manual run slower, not faster.
 */
export const DEFAULT_FETCH_CONCURRENCY = 5

/** Attempts per spec download before the snapshot run fails. */
export const DEFAULT_SPEC_ATTEMPTS = 10

/** Pause between spec download attempts, in milliseconds. */
const DEFAULT_SPEC_RETRY_DELAY_MS = 250

const CORE_SPEC_PATH = `${OPENAPI_DISCOVERY_PATH}/api/v1`
const CORE_SPEC_TITLE = 'Kubernetes'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const isCoreSpec = (url: string): boolean => {
  try {
    return new URL(url).pathname === CORE_SPEC_PATH
  } catch {
    return false
  }
}

/**
 * Wraps the fetch used for spec downloads so the snapshot does not depend on
 * which API server replica answers.
 *
 * Server errors are retried. The core `api/v1` spec gets one more check:
 * staging intermittently answers that path with a spec published by another
 * aggregated server (titled after that server, without ConfigMaps,
 * Namespaces or Secrets), so the download is repeated until Milo's own
 * `Kubernetes` spec comes back. A run that never gets it fails instead of
 * committing a schema with the core resources missing.
 */
export const stableSpecFetch = (
  fetcher: typeof fetch,
  { attempts = DEFAULT_SPEC_ATTEMPTS, delayMs = DEFAULT_SPEC_RETRY_DELAY_MS } = {}
): typeof fetch =>
  (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    let lastProblem = 'no attempts made'

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (attempt > 1) await sleep(delayMs)
      const response = await fetcher(input, init)

      if (response.status >= 500) {
        lastProblem = `status ${response.status}`
        continue
      }
      if (!isCoreSpec(url) || !response.ok) return response

      const body = await response.text()
      let title: unknown
      try {
        title = (JSON.parse(body) as { info?: { title?: unknown } }).info?.title
      } catch {
        title = undefined
      }
      if (title === CORE_SPEC_TITLE) {
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        })
      }
      lastProblem = `core spec titled ${JSON.stringify(title)}`
    }

    throw new Error(
      `Could not download ${url} after ${attempts} attempts (last: ${lastProblem}); ` +
        `expected the core spec titled ${CORE_SPEC_TITLE}`
    )
  }) as typeof fetch

export interface ComposeOptions {
  /** Base URL of the API server that serves the OpenAPI specs */
  server: string
  /** Fetch used for both discovery and spec downloads (carries auth) */
  fetch: typeof fetch
  /**
   * URL template baked into the composed subgraph transports. Defaults to
   * `${server}{context.headers.x-resource-endpoint-prefix}`, which is right
   * for a local run against a port-forward. The snapshot workflow passes the
   * in-cluster URL so the committed SDL stays environment-neutral.
   */
  endpoint?: string
  /** Number of spec downloads to run at once */
  concurrency?: number
}

export interface ComposeResult {
  sdl: string
  /** Every path listed by the discovery document, sorted */
  paths: string[]
}

const noop = () => {}
const meshLogger = {
  log: noop,
  debug: noop,
  info: noop,
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  child: () => meshLogger,
}

const trimServer = (server: string): string => server.replace(/\/+$/, '')

/**
 * Subgraph names must be stable across runs: they end up in the join
 * directive and an unstable name would rewrite the SDL on every snapshot.
 */
export const getSubgraphName = (path: string): string =>
  path
    .replace(/[^a-zA-Z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .toUpperCase()

/** Read the path list from the discovery document. */
export const fetchOpenApiPaths = async (
  fetcher: typeof fetch,
  server: string
): Promise<string[]> => {
  const response = await fetcher(`${trimServer(server)}${OPENAPI_DISCOVERY_PATH}`)
  if (!response.ok) {
    throw new Error(`Failed to fetch OpenAPI paths: ${response.status} ${response.statusText}`)
  }
  const data = (await response.json()) as { paths?: Record<string, unknown> }
  if (!data.paths) throw new Error('OpenAPI discovery document has no paths')
  return Object.keys(data.paths)
}

/**
 * Run async tasks over an array with a bounded concurrency limit so a
 * snapshot run does not open one connection per API group at once.
 */
async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
  return results
}

/**
 * Fetch every OpenAPI spec, trim shared types the servers disagree on, and
 * merge the result into one supergraph SDL.
 */
export const composeSupergraph = async ({
  server,
  fetch: fetcher,
  endpoint,
  concurrency = DEFAULT_FETCH_CONCURRENCY,
}: ComposeOptions): Promise<ComposeResult> => {
  const baseUrl = trimServer(server)
  const paths = await fetchOpenApiPaths(fetcher, baseUrl)
  const specFetch = stableSpecFetch(fetcher)

  const subgraphs = await mapConcurrent(paths, concurrency, async (path) => {
    const result = loadOpenAPISubgraph(getSubgraphName(path), {
      source: `${baseUrl}${OPENAPI_DISCOVERY_PATH}/${path}`,
      endpoint: endpoint ?? `${baseUrl}{context.headers.x-resource-endpoint-prefix}`,
      fetch: specFetch,
      operationHeaders: {
        Authorization: '{context.headers.authorization}',
      },
    })({
      fetch: specFetch,
      cwd: process.cwd(),
      logger: meshLogger,
    })
    const schema = await result.schema$
    return { name: result.name, schema }
  })

  // API servers vendor different apimachinery versions, so shared types like
  // ListMeta can disagree across subgraphs and break composition. Trim them to
  // the fields every subgraph agrees on. See align-shared-types.ts.
  const { subgraphs: aligned, removed } = alignSharedTypes(subgraphs)
  for (const [field, owners] of removed) {
    console.warn(
      `[compose] hiding ${field}: only defined by ${owners.length} subgraph(s) (${owners.join(', ')})`
    )
  }

  // composeSubgraphs() returns partial results plus an `errors` array instead
  // of throwing. getUnifiedGraphGracefully() throws on those errors, so a bad
  // subgraph fails the snapshot run instead of committing an empty schema.
  const sdl = await getUnifiedGraphGracefully(aligned)

  return { sdl, paths: [...paths].sort() }
}
