// Telemetry must be initialized before any other imports
import './telemetry/telemetry'

// Sentry must be initialized after OTEL (skipOpenTelemetrySetup hooks into it)
import { initSentry } from './telemetry/sentry'
initSentry()

import { createGatewayServer } from './server'
import { env, scopedEndpoints } from './config'
import { initAuth, getK8sServer } from './auth'
import { initializeGateway } from './runtime'
import { log } from '@/shared/utils'

const main = async () => {
  // Initialize K8s authentication before starting the server
  try {
    initAuth()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error('Failed to initialize K8s auth', { error: message })
    process.exit(1)
  }

  // Initialize gateway: compose supergraph eagerly + start background polling
  try {
    await initializeGateway()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error('Failed to initialize gateway', { error: message })
    process.exit(1)
  }

  const server = createGatewayServer()

  server.listen(env.port, () => {
    log.info(`Gateway listening on port ${env.port} (HTTPS)`)
    log.info(`K8s API server: ${getK8sServer()}`)
    log.info('Endpoints: /graphql, /healthcheck, /readiness, /metrics')

    if (scopedEndpoints.length > 0) {
      log.info('Scoped endpoints:')
      for (const endpoint of scopedEndpoints) {
        log.info(`  ${endpoint}`)
      }
    }
  })

  // Graceful shutdown
  const shutdown = (signal: string) => {
    log.info(`${signal} received, shutting down gracefully...`)
    server.close(() => {
      log.info('Server closed')
      process.exit(0)
    })
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
