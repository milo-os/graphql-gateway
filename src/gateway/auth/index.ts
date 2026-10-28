import { env } from '@/gateway/config'
import { getK8sMTLSConfig, createMTLSFetch } from '@/gateway/clients'
import type { K8sMTLSConfig } from '@/gateway/clients'
import { log } from '@/shared/utils'

// K8s mTLS state
let k8sServer: string | null = null
let mtlsFetch: typeof fetch | null = null
let mtlsConfig: K8sMTLSConfig | null = null
let initialized = false

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
  const originalFetch = globalThis.fetch
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url

    if (url.startsWith(k8sServer!)) {
      log.debug('Using mTLS fetch for K8s API request', { url })
      return mtlsFetch!(input, init)
    }

    return originalFetch(input, init)
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
 * Check if auth has been initialized.
 */
export function isInitialized(): boolean {
  return initialized
}
