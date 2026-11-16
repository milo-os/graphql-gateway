// Telemetry must be initialized before any other imports
import './telemetry/telemetry'

// Sentry must be initialized after OTEL (openTelemetryIntegration links to it)
import { initSentry } from './telemetry/sentry'
initSentry()

import { createGatewayServer, createInternalGraphQLServer, createMetricsServer } from './server'
import { env, scopedEndpoints } from './config'
import { initAuth, getK8sServer } from './auth'
import { initializeGateway } from './runtime'
import { initGeolocation } from './services/geolocation'
import { log } from '@/shared/utils'

const SHUTDOWN_DEADLINE_MS = 25_000

const main = async () => {
  // Initialize K8s authentication before starting the server
  try {
    initAuth()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error('Failed to initialize K8s auth', { error: message })
    process.exit(1)
  }

  // Initialize MaxMind geolocation database (optional)
  if (env.maxmindDbPath) {
    try {
      await initGeolocation(env.maxmindDbPath)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.warn('Failed to load MaxMind database, geolocation will be unavailable', {
        error: message,
      })
    }
  } else {
    log.info('MAXMIND_DB_PATH not set, geolocation lookups will be unavailable')
  }

  // Initialize gateway: load the committed supergraph snapshot, then check for drift
  try {
    await initializeGateway()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error('Failed to initialize gateway', { error: message })
    process.exit(1)
  }

  const server = createGatewayServer()
  const internalServer = createInternalGraphQLServer()
  const metricsServer = createMetricsServer()

  internalServer.listen(env.internalPort, () => {
    log.info(`Internal GraphQL listening on port ${env.internalPort} (HTTPS, no token check)`)
  })

  metricsServer.listen(env.metricsPort, () => {
    log.info(`Metrics listening on port ${env.metricsPort} (HTTPS, /metrics only)`)
  })

  server.listen(env.port, () => {
    log.info(`Gateway listening on port ${env.port} (HTTPS)`)
    log.info(`K8s API server: ${getK8sServer()}`)
    log.info(`GraphQL requests need a token Milo accepts (AUTH_MODE=${env.authMode})`)
    log.info('Endpoints: /graphql, /healthcheck, /readiness')

    if (scopedEndpoints.length > 0) {
      log.info('Scoped endpoints:')
      for (const endpoint of scopedEndpoints) {
        log.info(`  ${endpoint}`)
      }
    }
  })

  // Graceful shutdown
  let shuttingDown = false
  const shutdown = (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    log.info(`${signal} received, shutting down gracefully...`)
    // Scrapes are short and nothing waits on them, so the metrics port just stops.
    metricsServer.close()
    metricsServer.closeAllConnections()
    // Both GraphQL ports carry live requests, so exit once both have drained.
    const graphQLServers = [server, internalServer]
    let open = graphQLServers.length
    for (const s of graphQLServers) {
      s.close(() => {
        open -= 1
        if (open > 0) return
        log.info('Server closed')
        process.exit(0)
      })
      s.closeIdleConnections()
    }
    setTimeout(() => {
      log.warn('Shutdown deadline reached, closing remaining connections')
      for (const s of graphQLServers) s.closeAllConnections()
      process.exit(0)
    }, SHUTDOWN_DEADLINE_MS).unref()
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))

  process.on('unhandledRejection', (reason, promise) => {
    log.error('Unhandled Rejection at:', { promise, reason: String(reason) })
    // Do not exit process here
  })
}

main().catch((error) => {
  log.error('Startup failed', { error: String(error) })
  process.exit(1)
})
