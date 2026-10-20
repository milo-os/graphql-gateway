import type { LogLevel } from '@/shared/types'
import { config } from '@/shared/config'
import { trace } from '@opentelemetry/api'
import { getRequestContext } from '@/shared/request-context'

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

const currentLevel = LOG_LEVELS[config.logLevel]

/**
 * Ids of the call being served, merged into every line's data payload so a
 * support ticket can be followed from the portal through this log to Milo.
 */
const correlation = (): { requestId?: string; traceId?: string } | undefined => {
  const requestId = getRequestContext()?.requestId
  const traceId = trace.getActiveSpan()?.spanContext().traceId
  if (!requestId && !traceId) return undefined
  return { ...(requestId ? { requestId } : {}), ...(traceId ? { traceId } : {}) }
}

const formatMessage = (level: string, message: string, data?: object): string => {
  const timestamp = new Date().toISOString()
  const ids = correlation()
  const payload = data || ids ? { ...data, ...ids } : undefined
  const dataStr = payload ? ` ${JSON.stringify(payload)}` : ''
  return `${timestamp} [${level.toUpperCase()}] ${message}${dataStr}`
}

export const log = {
  debug: (message: string, data?: object): void => {
    if (currentLevel <= LOG_LEVELS.debug) {
      console.debug(formatMessage('debug', message, data))
    }
  },
  info: (message: string, data?: object): void => {
    if (currentLevel <= LOG_LEVELS.info) {
      console.info(formatMessage('info', message, data))
    }
  },
  warn: (message: string, data?: object): void => {
    if (currentLevel <= LOG_LEVELS.warn) {
      console.warn(formatMessage('warn', message, data))
    }
  },
  error: (message: string, data?: object): void => {
    if (currentLevel <= LOG_LEVELS.error) {
      console.error(formatMessage('error', message, data))
    }
  },
}
