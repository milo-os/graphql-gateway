import { config as sharedConfig } from '@/shared/config'
import { log } from '@/shared/utils'

/** Largest delay setTimeout accepts; anything above it silently wraps to 1ms. */
const MAX_TIMER_MS = 2_147_483_647

/**
 * Parses a millisecond duration from the environment. Falls back when the
 * value is unset, non-numeric, zero or negative, and clamps values beyond
 * what a timer can hold. Both cases are logged so a typo in the unit does
 * not pass unnoticed.
 */
export const positiveMillis = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw === '') return fallback
  const parsed = Math.floor(Number(raw))
  if (!Number.isFinite(parsed) || parsed <= 0) {
    log.warn('Ignoring invalid duration from environment', { raw, fallback })
    return fallback
  }
  if (parsed > MAX_TIMER_MS) {
    log.warn('Clamping duration from environment', { raw, clampedTo: MAX_TIMER_MS })
    return MAX_TIMER_MS
  }
  return parsed
}

/**
 * Environment configuration for the gateway.
 * All values can be overridden via environment variables.
 */
export const env = {
  /** Port for the gateway (default: 4000) */
  port: Number(process.env.PORT) || 4000,

  /** Log level for the gateway */
  logLevel: sharedConfig.logLevel,

  /** Path to the KUBECONFIG file (required) */
  kubeconfigPath: process.env.KUBECONFIG || '',

  /** Polling interval for supergraph composition in milliseconds (default: 40m) */
  pollingInterval: Number(process.env.POLLING_INTERVAL) || 2_400_000,

  /** Deadline for response headers on every upstream call to Milo, in milliseconds (default: 10s) */
  upstreamTimeoutMs: positiveMillis(process.env.UPSTREAM_TIMEOUT_MS, 10_000),

  /** OTLP URL for telemetry */
  otlpUrl: process.env.OTLP_URL || '',

  /** OTLP timeout in milliseconds */
  otlpTimeout: Number(process.env.OTLP_TIMEOUT) || 30000,

  /** OTLP queue size */
  otlpQueueSize: Number(process.env.OTLP_QUEUE_SIZE) || 512,

  /** OTLP batch size */
  otlpBatchSize: Number(process.env.OTLP_BATCH_SIZE) || 128,

  /** OTLP scheduled delay in milliseconds */
  otlpScheduledDelayMillis: Number(process.env.OTLP_SCHEDULED_DELAY_MILLIS) || 2000,

  /** OTLP export timeout in milliseconds */
  otlpExportTimeoutMillis: Number(process.env.OTLP_EXPORT_TIMEOUT_MILLIS) || 30000,

  /** Directory containing TLS certificates for HTTPS (tls.crt and tls.key) */
  certDir: process.env.CERT_DIR || '',

  /** Sentry DSN for error and performance monitoring */
  sentryDsn: process.env.SENTRY_DSN || '',

  /** Sentry environment name */
  sentryEnv: process.env.SENTRY_ENV || process.env.NODE_ENV || 'development',

  /** Service version for Sentry release tracking */
  version: process.env.VERSION || 'dev',

  /** Path to the MaxMind GeoLite2-City.mmdb database file */
  maxmindDbPath: process.env.MAXMIND_DB_PATH || '',
}
