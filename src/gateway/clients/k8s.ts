import { readFileSync } from 'node:fs'
import * as https from 'node:https'
import { KubeConfig } from '@kubernetes/client-node'
import * as Sentry from '@sentry/node'
import { Agent, fetch as undiciFetch } from 'undici'
import { log } from '@/shared/utils'

/**
 * Connection pool settings for requests that authenticate as the end user.
 *
 * Node's global fetch keeps idle sockets for only 4s and has no per-origin
 * connection cap, so a batch of N concurrent Milo calls (e.g. one
 * organizationMembers alias per org) opens N new TCP + TLS connections, each
 * with its own ndots:5 DNS search, and throws them away before the next page
 * load. Keeping a bounded pool warm makes those calls reuse connections.
 *
 * keepAliveTimeout stays under the 90s idle timeout k8s apiservers set on
 * their HTTP server, so the gateway, not Milo, closes idle sockets.
 *
 * The connection cap is shared by every user on the pod. It bounds bursts on
 * Milo; when all connections are busy, further calls queue. The
 * graphql_gateway_local_fetch_inflight gauge shows how close a pod gets.
 *
 * kube-proxy balances per connection, and undici reuses the first free
 * connection, so light traffic stays on one or two Milo replicas. clientTtl
 * replaces each connection after 5 minutes, which limits how long that skew
 * lasts and lets new replicas pick up traffic. It does not remove the skew.
 */
export const USER_FETCH_AGENT_OPTIONS = {
  keepAliveTimeout: 60_000,
  keepAliveMaxTimeout: 60_000,
  connections: 128,
  clientTtl: 5 * 60_000,
} as const

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
 * Create a fetch for K8s API requests that authenticate as the end user via
 * a forwarded bearer token, so no client cert is presented.
 *
 * Uses undici's own fetch with a dedicated pooled Agent rather than passing
 * the Agent to Node's global fetch, whose bundled undici is a different
 * major version. undici publishes the same diagnostics channels, so
 * Sentry/OTEL fetch spans still cover these requests.
 *
 * Milo's server cert is validated via NODE_EXTRA_CA_CERTS.
 */
export function createUserFetch(): typeof fetch {
  const agent = new Agent(USER_FETCH_AGENT_OPTIONS)
  return ((input: Parameters<typeof undiciFetch>[0], init?: Parameters<typeof undiciFetch>[1]) =>
    undiciFetch(input, { ...init, dispatcher: agent })) as unknown as typeof fetch
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

  // Create HTTPS agent with mTLS and connection keep-alive to avoid
  // a full TCP + mTLS handshake on every request.
  const agent = new https.Agent({
    cert,
    key,
    ca,
    rejectUnauthorized: true,
    keepAlive: true,
    keepAliveMsecs: 60_000,
    maxSockets: 50,
  })

  log.info('mTLS fetch created successfully')

  // Return custom fetch using the mTLS agent
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const parsedUrl = new URL(url)
    const method = init?.method || 'GET'

    // Normalise headers to a plain object so https.request can read them
    // regardless of whether the caller passed a Headers instance or a plain object.
    const rawHeaders = init?.headers
    const headers: Record<string, string> =
      rawHeaders instanceof Headers
        ? Object.fromEntries(rawHeaders.entries())
        : (rawHeaders as Record<string, string>) ?? {}

    return Sentry.startSpan(
      {
        op: 'http.client',
        name: `${method} ${parsedUrl.pathname}`,
        attributes: {
          'http.request.method': method,
          'url.full': url,
          'server.address': parsedUrl.hostname,
          'server.port': Number(parsedUrl.port) || 443,
        },
      },
      (span) =>
        new Promise<Response>((resolve, reject) => {
          const options: https.RequestOptions = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || 443,
            path: parsedUrl.pathname + parsedUrl.search,
            method,
            headers,
            agent,
          }

          const req = https.request(options, (res) => {
            const chunks: Buffer[] = []

            res.on('data', (chunk: Buffer) => chunks.push(chunk))
            res.on('end', () => {
              const statusCode = res.statusCode || 200
              span.setAttribute('http.response.status_code', statusCode)
              if (statusCode >= 400) {
                span.setStatus({ code: 2, message: res.statusMessage || 'Error' })
              }

              const body = Buffer.concat(chunks).toString('utf8')
              const response = new Response(body, {
                status: statusCode,
                statusText: res.statusMessage || 'OK',
                headers: new Headers(res.headers as Record<string, string>),
              })

              resolve(response)
            })
          })

          req.on('error', (error) => {
            span.setStatus({ code: 2, message: error.message })
            log.error('mTLS request failed', { url, error: error.message })
            reject(error)
          })

          // Propagate abort signal so upstream requests are cancelled when the
          // client disconnects — frees mTLS agent sockets without waiting for milo.
          init?.signal?.addEventListener('abort', () => {
            req.destroy()
            reject(new DOMException('The operation was aborted.', 'AbortError'))
          })

          // Write body if present
          if (init?.body) {
            req.write(init.body)
          }

          req.end()
        }),
    )
  }
}
