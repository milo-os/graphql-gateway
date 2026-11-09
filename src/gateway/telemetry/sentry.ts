import * as Sentry from '@sentry/node'
import { env } from '@/gateway/config'
import { log } from '@/shared/utils'

const SCRUBBED_KEYS = ['forwarded', '-ip', 'remote-', 'via', '-user']

/**
 * Initialize Sentry for error reporting.
 *
 * OpenTelemetry (telemetry.ts) owns tracing and exports spans over OTLP.
 * Sentry captures errors only and links them to the active OpenTelemetry
 * span through openTelemetryIntegration.
 */
export function initSentry(): void {
  if (!env.sentryDsn) {
    log.info('[sentry] SENTRY_DSN not set, Sentry disabled')
    return
  }

  Sentry.init({
    dsn: env.sentryDsn,
    environment: env.sentryEnv,
    release: env.version,
    integrations: [Sentry.openTelemetryIntegration()],
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: {
        request: { deny: SCRUBBED_KEYS },
        response: { deny: SCRUBBED_KEYS },
      },
      httpBodies: [],
      urlQueryParams: { deny: SCRUBBED_KEYS },
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      graphQL: { document: false, variables: false },
    },
  })

  log.info('[sentry] Initialized', { environment: env.sentryEnv, release: env.version })
}
