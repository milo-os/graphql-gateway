import { env } from '@/gateway/config'
import { getK8sMTLSConfig, createMTLSFetch } from '@/gateway/clients'
import { instrumentFetch } from '@/gateway/metrics/upstream-fetch'
import type { K8sMTLSConfig } from '@/gateway/clients'
import { log } from '@/shared/utils'

// K8s mTLS state
let k8sServer: string | null = null
let mtlsFetch: typeof fetch | null = null
let mtlsConfig: K8sMTLSConfig | null = null
let initialized = false
// Saved before the global fetch override so callers that explicitly want to
// bypass mTLS (e.g. the local sessions resolver, which needs milo to
// authenticate the *end user* via bearer token rather than the gateway via
// client cert) can still reach the K8s server with a plain fetch.
let savedOriginalFetch: typeof fetch | null = null
// savedOriginalFetch with duration / in-flight metrics, handed to resolvers.
let instrumentedOriginalFetch: typeof fetch | null = null

/**
 * Initialize K8s authentication by loading mTLS credentials from kubeconfig.
 *
 * This also overrides the global fetch to use mTLS for ALL HTTP requests
 * to the K8s API server, including internal GraphQL Mesh fetches.
 *
 * @throws Error if KUBECONFIG is not set or kubeconfig is invalid
 */
export function initAuth(): void {
  if (initialized) {
    log.warn('K8s auth already initialized, skipping')
    return
  }

  if (!env.kubeconfigPath) {
    throw new Error('KUBECONFIG environment variable is required')
  }

  mtlsConfig = getK8sMTLSConfig({ kubeconfigPath: env.kubeconfigPath })

  k8sServer = mtlsConfig.server
  mtlsFetch = createMTLSFetch(mtlsConfig)

  // Override global fetch to use mTLS for requests to the K8s API server
  savedOriginalFetch = globalThis.fetch
  instrumentedOriginalFetch = instrumentFetch(savedOriginalFetch)
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url

    if (url.startsWith(k8sServer!)) {
      log.debug('Using mTLS fetch for K8s API request', { url })
      return mtlsFetch!(input, init)
    }

    return savedOriginalFetch!(input, init)
  }) as typeof fetch

  initialized = true
  log.info('K8s mTLS auth initialized', { server: k8sServer })
}

/**
 * Get the K8s cluster server URL.
 * @throws Error if auth not initialized
 */
export function getK8sServer(): string {
  if (!k8sServer) {
    throw new Error('K8s auth not initialized. Call initAuth() first.')
  }
  return k8sServer
}

/**
 * Get the mTLS fetch function for making authenticated requests.
 * @throws Error if auth not initialized
 */
export function getMTLSFetch(): typeof fetch {
  if (!mtlsFetch) {
    throw new Error('K8s auth not initialized. Call initAuth() first.')
  }
  return mtlsFetch
}

/**
 * Get the mTLS configuration (cert paths + server URL).
 * Used by the composition worker thread to set up its own mTLS fetch.
 * @throws Error if auth not initialized
 */
export function getMTLSConfig(): K8sMTLSConfig {
  if (!mtlsConfig) {
    throw new Error('K8s auth not initialized. Call initAuth() first.')
  }
  return mtlsConfig
}

/**
 * Get the pre-override fetch for callers that need to reach the K8s API
 * server WITHOUT presenting the gateway's client cert.
 *
 * The default global fetch routes K8s-bound requests through the mTLS agent,
 * which means K8s authenticates the request as the gateway's identity. For
 * user-scoped paths that need milo to authenticate the *end user* via the
 * forwarded bearer token, callers must use this fetch instead so no client
 * cert is presented and the bearer-token authenticator wins.
 *
 * Node's TLS still validates milo's server cert via NODE_EXTRA_CA_CERTS.
 * Calls are recorded in the graphql_gateway_local_fetch_* metrics.
 *
 * @throws Error if auth not initialized
 */
export function getOriginalFetch(): typeof fetch {
  if (!instrumentedOriginalFetch) {
    throw new Error('K8s auth not initialized. Call initAuth() first.')
  }
  return instrumentedOriginalFetch
}

/**
 * Check if auth has been initialized.
 */
export function isInitialized(): boolean {
  return initialized
}
