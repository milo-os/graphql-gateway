import { config as sharedConfig } from '@/shared/config'

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

  /** Polling interval for supergraph composition in milliseconds (default: 20m) */
  pollingInterval: Number(process.env.POLLING_INTERVAL) || 1_200_000,

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
}
