import { Worker } from 'node:worker_threads'
import { createGatewayRuntime } from '@graphql-hive/gateway'
import { useOpenTelemetry } from '@graphql-hive/plugin-opentelemetry'
import { unifiedGraphHandler } from '@graphql-hive/router-runtime'
import { env } from '@/gateway/config'
import { getMTLSConfig } from '@/gateway/auth'
import { log } from '@/shared/utils'
import { usePrometheusMetrics } from '@/gateway/metrics/metrics'
import { additionalTypeDefs, additionalResolvers } from '@/gateway/graphql'

/** Cached supergraph SDL - updated by the worker after each composition cycle */
let supergraphSdl: string = ''

/**
 * Guards against overlapping composition cycles.
 * When the polling interval fires while a cycle is already running the new
 * trigger is silently dropped – the in-progress result will be used instead.
 */
let isComposing = false

/** True once the first composition has succeeded and supergraphSdl is valid */
let isReady = false

/** Persistent worker thread that owns all composition CPU & I/O work */
let composeWorker: Worker | null = null

/**
 * Reject function for the currently in-flight composeSupergraph() Promise.
 *
 * The worker's 'error' and 'exit' events fire on the worker object itself, not
 * inside the Promise executor, so they cannot directly reject the Promise.
 * Storing the reject here lets those handlers abort a pending composition
 * instead of leaving the Promise hanging forever (which would stall startup
 * or silently drop polling cycles).
 *
 * Cleared to null whenever the Promise settles (success, worker error, or exit).
 */
let pendingReject: ((err: Error) => void) | null = null

/**
 * Resolve the worker script path for the current runtime environment.
 */
const resolveWorkerPath = (): { url: URL; execArgv: string[] } => {
  const isDev = new URL(import.meta.url).pathname.endsWith('.ts')
  return isDev
    ? { url: new URL('./compose-worker.ts', import.meta.url), execArgv: ['--import', 'tsx'] }
    : { url: new URL('./compose-worker.js', import.meta.url), execArgv: [] }
}

/**
 * Spawn the persistent composition worker thread.
 *
 * mTLS config is passed via workerData so the worker can authenticate against
 * the k8s API server without importing from our path-aliased source modules
 */
const startWorker = (): Worker => {
  const { url, execArgv } = resolveWorkerPath()
  const { server, certPath, keyPath, caPath } = getMTLSConfig()

  const worker = new Worker(url, {
    execArgv,
    workerData: { server, certPath, keyPath, caPath },
  })

  worker.on('error', (err) => {
    log.error(`Composition worker error: ${err}`)
    isComposing = false
    // Reject any in-flight composeSupergraph() Promise so the caller
    // (initializeGateway or the polling setInterval) is notified immediately
    // rather than waiting forever for a message that will never arrive.
    pendingReject?.(err)
    pendingReject = null
  })

  worker.on('exit', (code) => {
    if (code !== 0) {
      const err = new Error(`Composition worker exited unexpectedly with code ${code}`)
      log.error(err.message)
      isComposing = false
      pendingReject?.(err)
      pendingReject = null
    }
  })

  return worker
}

/**
 * Trigger a supergraph composition cycle in the worker thread.
 *
 * Posts a `{ type: 'compose' }` message to the worker and resolves with the
 * new SDL when the worker responds.  All CPU-intensive work (OpenAPI fetching,
 * schema conversion, composeSubgraphs) runs entirely in the worker thread so
 * the main event loop stays free to serve HTTP requests throughout.
 *
 * If a cycle is already running the function returns the current cached SDL
 * immediately – overlapping cycles are dropped, not queued.
 */
const composeSupergraph = (): Promise<string> => {
  if (isComposing) {
    log.info('Supergraph composition already in progress, skipping...')
    return Promise.resolve(supergraphSdl)
  }

  isComposing = true
  log.info('Composing supergraph from OpenAPI specs...')

  return new Promise((resolve, reject) => {
    pendingReject = reject

    const handler = (result: { sdl?: string; error?: string }) => {
      pendingReject = null
      isComposing = false

      if (result.error) {
        log.error(`Supergraph composition failed: ${result.error}`)
        reject(new Error(result.error))
      } else {
        supergraphSdl = result.sdl!
        isReady = true
        log.info('Supergraph composed successfully')
        resolve(result.sdl!)
      }
    }

    composeWorker!.once('message', handler)
    composeWorker!.postMessage({ type: 'compose' })
  })
}

/**
 * Returns the cached supergraph SDL synchronously.
 *
 * This is passed directly to `createGatewayRuntime` as the `supergraph`
 * option.  Because it returns a plain string (not a Promise), Hive Gateway
 * treats the schema as already resolved and never awaits anything on the
 * request path.  The cache is updated in the background by the worker thread
 * without ever touching request handling.
 */
const getSupergraph = (): string => {
  if (!supergraphSdl) {
    log.warn('Supergraph not ready yet – returning empty SDL')
  }
  return supergraphSdl
}

/** True once the supergraph has been composed at least once successfully */
export const isSupergraphReady = (): boolean => isReady

/**
 * Start background polling to keep the supergraph SDL fresh.
 *
 * Each tick sends a compose request to the worker thread.  The main event
 * loop is never blocked – the worker does all the heavy lifting and posts
 * the result back asynchronously.
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
 * Bootstrap the gateway: spawn the composition worker, run the first
 * composition eagerly (blocking startup until the SDL is ready), then kick
 * off background polling.
 *
 * Must complete before the HTTP server begins accepting connections so that
 * `getSupergraph()` always returns a valid SDL on the very first request.
 */
export const initializeGateway = async (): Promise<void> => {
  composeWorker = startWorker()
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
  logging: env.logLevel,
  unifiedGraphHandler,
  additionalTypeDefs,
  additionalResolvers,
  plugins: (ctx) => [
    // Uses the SDK configured in telemetry/telemetry.ts via openTelemetrySetup
    useOpenTelemetry({}),
    // Uses the SDK configured in metrics/metrics.ts via usePrometheusMetrics
    usePrometheusMetrics(ctx),
  ],
})
