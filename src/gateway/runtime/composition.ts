import { Worker } from 'node:worker_threads'
import { env } from '@/gateway/config'
import { getMTLSConfig } from '@/gateway/auth'
import { log } from '@/shared/utils'

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
 * Delay before each attempt to replace a worker that exited. Once the list
 * is exhausted the gateway stops trying and reports itself not ready and not
 * live: readiness takes the pod out of the Service, and the failing liveness
 * probe makes the kubelet restart the container, instead of letting it serve
 * a frozen supergraph forever. The count resets only after a replacement has
 * composed and then stayed up for STABLE_WINDOW_MS, so a worker that crashes
 * right after every compose still escalates instead of restarting every
 * second and re-running a full composition each time.
 *
 * Startup is deliberately fail-fast: if the first compose fails,
 * initializeGateway rejects and the process exits, leaving the container
 * restart policy to retry. This machinery covers a worker that dies later.
 */
const RESPAWN_BACKOFF_MS = [1_000, 5_000, 30_000]
const STABLE_WINDOW_MS = 10 * 60_000
let respawnAttempts = 0
let workerSpawnedAt = 0
let givenUp = false

/**
 * A worker that never answers a compose would leave isComposing true forever
 * and every later cycle skipped, with the readiness probe still green. After
 * this long the worker is terminated, which runs the normal restart path.
 */
const COMPOSE_TIMEOUT_MS = 3 * 60_000

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
    ? { url: new URL('./compose-worker-bootstrap.mjs', import.meta.url), execArgv: [] }
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
  workerSpawnedAt = Date.now()

  worker.on('error', (err) => {
    log.error('Composition worker error', { error: err.message, stack: err.stack })
    isComposing = false
    // Reject any in-flight composeSupergraph() Promise so the caller
    // (initializeGateway or the polling setInterval) is notified immediately
    // rather than waiting forever for a message that will never arrive.
    pendingReject?.(err)
    pendingReject = null
  })

  worker.on('exit', (code) => {
    const err = new Error(`Composition worker exited unexpectedly with code ${code}`)
    log.error('Composition worker exited unexpectedly', { code })
    isComposing = false
    pendingReject?.(err)
    pendingReject = null
    // Only the current worker's exit triggers a restart; a late exit event
    // from a worker that was already replaced must not spawn another one.
    if (composeWorker === worker) {
      composeWorker = null
      scheduleRespawn()
    }
  })

  return worker
}

/**
 * Replace a dead worker after a backoff, or give up and go not-ready once the
 * schedule is exhausted. The worker is meant to live for the whole process,
 * so any exit is treated as a failure regardless of its exit code.
 */
const scheduleRespawn = (): void => {
  const delayMs = RESPAWN_BACKOFF_MS[respawnAttempts]
  if (delayMs === undefined) {
    isReady = false
    givenUp = true
    log.error('Composition worker kept exiting; giving up and reporting not ready and not live', {
      attempts: respawnAttempts,
    })
    return
  }
  respawnAttempts += 1
  log.warn('Restarting composition worker', { attempt: respawnAttempts, delayMs })
  setTimeout(() => {
    try {
      composeWorker = startWorker()
    } catch (error) {
      // Thrown inside a timer this would be an uncaught exception and take
      // the process down; treat it like another failed attempt instead.
      log.error('Failed to restart composition worker', {
        error: error instanceof Error ? error.message : String(error),
      })
      scheduleRespawn()
      return
    }
    // Recompose right away rather than serving the pre-crash schema until
    // the next poll, which is 40 minutes out by default. Success resets the
    // backoff; failure is logged and the poll loop retries as usual.
    composeSupergraph().catch((error: unknown) => {
      log.error('Compose after worker restart failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }, delayMs)
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
export const composeSupergraph = (): Promise<string> => {
  if (isComposing) {
    log.info('Supergraph composition already in progress, skipping...')
    return Promise.resolve(supergraphSdl)
  }
  if (!composeWorker) {
    return Promise.reject(new Error('No composition worker is alive; waiting for it to restart'))
  }

  isComposing = true
  log.info('Composing supergraph from OpenAPI specs...')

  const worker = composeWorker
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      log.error('Composition worker did not answer in time; terminating it', {
        timeoutMs: COMPOSE_TIMEOUT_MS,
      })
      // terminate() emits 'exit', whose handler rejects this promise and
      // schedules the replacement.
      void worker.terminate()
    }, COMPOSE_TIMEOUT_MS)

    pendingReject = (err) => {
      clearTimeout(timer)
      reject(err)
    }

    const handler = (result: { sdl?: unknown; error?: unknown }) => {
      clearTimeout(timer)
      pendingReject = null
      isComposing = false

      if (result.error) {
        log.error('Supergraph composition failed', { error: String(result.error) })
        reject(new Error(String(result.error)))
      } else if (typeof result.sdl !== 'string' || result.sdl.length === 0) {
        log.error('Composition worker replied without an sdl string; keeping the previous schema')
        reject(new Error('Composition worker replied without an sdl string'))
      } else {
        supergraphSdl = result.sdl
        isReady = true
        if (Date.now() - workerSpawnedAt >= STABLE_WINDOW_MS) respawnAttempts = 0
        log.info('Supergraph composed successfully')
        resolve(result.sdl)
      }
    }

    worker.once('message', handler)
    worker.postMessage({ type: 'compose' })
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
export const getSupergraph = (): string => {
  if (!supergraphSdl) {
    log.warn('Supergraph not ready yet – returning empty SDL')
  }
  return supergraphSdl
}

/** True once the supergraph has been composed at least once successfully */
export const isSupergraphReady = (): boolean => isReady

/** True once the worker restart schedule is exhausted; the liveness probe fails on it. */
export const hasCompositionGivenUp = (): boolean => givenUp

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
      log.error('Failed to refresh supergraph', {
        error: error instanceof Error ? error.message : String(error),
      })
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
