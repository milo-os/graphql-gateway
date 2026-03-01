import { readFileSync } from 'node:fs'
import * as https from 'node:https'
import { KubeConfig } from '@kubernetes/client-node'
import { log } from '@/shared/utils'

export interface K8sAuthConfig {
  /** Path to kubeconfig file (required) */
  kubeconfigPath: string
}

export interface K8sMTLSConfig {
  /** Cluster server URL */
  server: string
  /** Path to client certificate */
  certPath: string
  /** Path to client key */
  keyPath: string
  /** Path to CA certificate */
  caPath: string
}

/**
 * Load kubeconfig and extract mTLS configuration.
 *
 * @param config - Configuration with kubeconfig file path
 * @returns mTLS configuration including cert paths and server URL
 * @throws Error if kubeconfig cannot be loaded or cert paths not found
 */
export function getK8sMTLSConfig(config: K8sAuthConfig): K8sMTLSConfig {
  const { kubeconfigPath } = config

  log.debug('Loading kubeconfig', { path: kubeconfigPath })

  const kubeConfig = new KubeConfig()

  try {
    kubeConfig.loadFromFile(kubeconfigPath)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error('Failed to load kubeconfig', { path: kubeconfigPath, error: message })
    throw new Error(`Failed to load kubeconfig from ${kubeconfigPath}: ${message}`)
  }

  const cluster = kubeConfig.getCurrentCluster()
  if (!cluster?.server) {
    throw new Error('No cluster server found in kubeconfig')
  }

  const user = kubeConfig.getCurrentUser()
  if (!user) {
    throw new Error('No user found in kubeconfig')
  }

  // Check for client certificate auth
  if (!user.certFile) {
    throw new Error('No client certificate path found in kubeconfig user')
  }
  if (!user.keyFile) {
    throw new Error('No client key path found in kubeconfig user')
  }

  // CA can be in cluster config
  const caPath = cluster.caFile
  if (!caPath) {
    throw new Error('No CA certificate path found in kubeconfig cluster')
  }

  log.info('Kubeconfig loaded', {
    context: kubeConfig.getCurrentContext(),
    cluster: cluster.server,
    user: user.name,
    certPath: user.certFile,
    keyPath: user.keyFile,
    caPath,
  })

  return {
    server: cluster.server,
    certPath: user.certFile,
    keyPath: user.keyFile,
    caPath,
  }
}

/**
 * Create a custom fetch function that uses mTLS for authentication.
 *
 * @param mtlsConfig - mTLS configuration with cert paths
 * @returns Fetch function with mTLS support
 */
export function createMTLSFetch(mtlsConfig: K8sMTLSConfig): typeof fetch {
  log.debug('Creating mTLS fetch', {
    certPath: mtlsConfig.certPath,
    keyPath: mtlsConfig.keyPath,
    caPath: mtlsConfig.caPath,
  })

  // Read certificates
  const cert = readFileSync(mtlsConfig.certPath, 'utf8')
  const key = readFileSync(mtlsConfig.keyPath, 'utf8')
  const ca = readFileSync(mtlsConfig.caPath, 'utf8')

  // Create HTTPS agent with mTLS
  const agent = new https.Agent({
    cert,
    key,
    ca,
    rejectUnauthorized: true,
  })

  log.info('mTLS fetch created successfully')

  // Return custom fetch using the mTLS agent
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
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
          const body = Buffer.concat(chunks).toString('utf8')

          // Create a Response-like object
          const response = new Response(body, {
            status: res.statusCode || 200,
            statusText: res.statusMessage || 'OK',
            headers: new Headers(res.headers as Record<string, string>),
          })

          resolve(response)
        })
      })

      req.on('error', (error) => {
        log.error('mTLS request failed', { url, error: error.message })
        reject(error)
      })

      // Write body if present
      if (init?.body) {
        req.write(init.body)
      }

      req.end()
    })
  }
}
