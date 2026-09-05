/**
 * Composition Worker Thread
 *
 * This file runs in a Node.js Worker Thread spawned by `runtime/index.ts`.
 * Its sole responsibility is to compose the supergraph SDL from the k8s
 * OpenAPI discovery endpoint and return the result to the main thread.
 *
 * ## Why a worker thread?
 *
 * Composing a supergraph from ~50 OpenAPI specs is CPU-intensive:
 *   - Each spec must be fetched from the k8s API server (async I/O).
 *   - Each spec is converted to a GraphQL schema by loadOpenAPISubgraph (CPU).
 *   - All schemas are merged into one supergraph SDL by composeSubgraphs (CPU).
 *
 * Steps 2 & 3 are synchronous and dominate the total runtime (~14–16 s in our
 * staging environment).  When this work ran on the main thread it blocked the
 * Node.js event loop for the entire duration, preventing HTTP response
 * callbacks from running.  Any API request that arrived during a composition
 * cycle would stall until the cycle completed – even though its own handler
 * had already been called and logged.
 *
 * Worker threads are true OS threads.  CPU work inside a worker does not
 * affect the main thread's event loop at all.
 *
 * ## Concurrency limit
 *
 * The worker fetches schemas with a bounded concurrency of FETCH_CONCURRENCY
 * (default 5) rather than firing all ~50 requests simultaneously.  Firing all
 * at once saturated the kubectl port-forward / k8s API server, leaving no
 * connection capacity for live GraphQL execution requests.  With a limit of 5
 * the composition takes marginally longer but user-facing requests are no
 * longer starved of k8s connections during composition.
 *
 * ## Communication protocol
 *
 * The worker listens for messages from the main thread:
 *   - Receives: `{ type: 'compose' }`
 *   - Responds:  `{ sdl: string }` on success
 *   - Responds:  `{ error: string }` on failure
 *
 * The main thread registers a one-time `once('message')` handler before each
 * compose request, so each request/response pair is matched exactly.
 *
 * ## Import restrictions
 *
 * DO NOT use tsconfig path aliases (@/) in this file.
 * tsx's `--import` hook (used to run TypeScript in the worker in dev mode)
 * does not resolve tsconfig `paths` mappings.  Every import here must be
 * either a Node.js built-in (`node:*`) or a bare npm package name.
 *
 * mTLS credentials (server URL, cert paths) are passed in via `workerData`
 * by the main thread after it has initialised auth, so the worker never
 * needs to import from our own source modules.
 */
import { workerData, parentPort } from 'node:worker_threads'
import { readFileSync } from 'node:fs'
import * as https from 'node:https'
import { getUnifiedGraphGracefully } from '@graphql-mesh/compose-cli'
import { loadOpenAPISubgraph } from '@omnigraph/openapi'

interface MTLSWorkerData {
  server: string
  certPath: string
  keyPath: string
  caPath: string
}

const { server, certPath, keyPath, caPath } = workerData as MTLSWorkerData

/** Build an mTLS fetch using the cert paths passed from the main thread */
const cert = readFileSync(certPath, 'utf8')
const key = readFileSync(keyPath, 'utf8')
const ca = readFileSync(caPath, 'utf8')
const agent = new https.Agent({ cert, key, ca, rejectUnauthorized: true })

const mtlsFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const parsedUrl = new URL(url)

  return new Promise((resolve, reject) => {
    const options: https.RequestOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 443,
      path: parsedUrl.pathname + parsedUrl.search,
      method: init?.method || 'GET',
      headers: init?.headers as Record<string, string>,
      agent,
    }

    const req = https.request(options, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        resolve(
          new Response(Buffer.concat(chunks).toString('utf8'), {
            status: res.statusCode || 200,
            statusText: res.statusMessage || 'OK',
            headers: new Headers(res.headers as Record<string, string>),
          })
        )
      })
    })

    req.on('error', reject)
    if (init?.body) req.write(init.body)
    req.end()
  })
}

/** Route k8s-bound requests through mTLS; everything else uses the built-in fetch */
const originalFetch = globalThis.fetch
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (url.startsWith(server)) return mtlsFetch(input, init)
  return originalFetch(input, init)
}) as typeof fetch

const noop = () => {}
const meshLogger = {
  log: noop,
  debug: noop,
  info: noop,
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  child: () => meshLogger,
}

const getSubgraphName = (path: string): string =>
  path
    .replace(/[^a-zA-Z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .toUpperCase()

const fetchApis = async (): Promise<Array<{ path: string }>> => {
  const response = await fetch(`${server}/openapi/v3`)
  if (!response.ok) {
    throw new Error(`Failed to fetch OpenAPI paths: ${response.status} ${response.statusText}`)
  }
  const data = (await response.json()) as { paths: Record<string, unknown> }
  return Object.keys(data.paths).map((path) => ({ path }))
}

/**
 * Run async tasks over an array with a bounded concurrency limit.
 * Prevents saturating the k8s API server / kubectl port-forward by
 * keeping at most `concurrency` in-flight requests at a time.
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
 * Maximum number of OpenAPI spec fetches to run concurrently.
 *
 * With ~50 APIs, running all fetches simultaneously creates ~50 TCP connections
 * through the kubectl port-forward at once.  This saturates the port-forward's
 * connection pool and the k8s API server's request handling capacity, causing
 * live GraphQL execution requests (which also need k8s connections) to queue
 * behind composition requests.
 *
 * Limiting to 5 keeps k8s load manageable and leaves connection headroom for
 * user traffic.  Composition takes slightly longer (sequential batches) but
 * API latency during composition drops from seconds to normal.
 */
const FETCH_CONCURRENCY = 5

const runComposition = async (): Promise<string> => {
  const apis = await fetchApis()

  const subgraphs = await mapConcurrent(apis, FETCH_CONCURRENCY, async ({ path }) => {
    const result = loadOpenAPISubgraph(getSubgraphName(path), {
      source: `${server}/openapi/v3/${path}`,
      endpoint: `${server}{context.headers.x-resource-endpoint-prefix}`,
      fetch: mtlsFetch,
      operationHeaders: {
        Authorization: '{context.headers.authorization}',
      },
    })({
      fetch: globalThis.fetch,
      cwd: process.cwd(),
      logger: meshLogger,
    })
    const schema = await result.schema$
    return { name: result.name, schema }
  })

  // composeSubgraphs() (the raw function) returns partial/empty results plus a
  // separate `errors` array instead of throwing - silently discarding that
  // array means a subgraph that fails to merge produces an empty supergraph
  // that gets treated as a successful composition. getUnifiedGraphGracefully()
  // wraps the same call and throws when `errors` is non-empty, so a bad
  // subgraph fails this cycle loudly and the previously cached SDL keeps
  // serving instead of getting silently overwritten with nothing.
  return getUnifiedGraphGracefully(subgraphs)
}

parentPort!.on('message', async (msg: { type: string }) => {
  if (msg.type !== 'compose') return

  try {
    const sdl = await runComposition()
    parentPort!.postMessage({ sdl })
  } catch (error) {
    parentPort!.postMessage({ error: String(error) })
  }
})
