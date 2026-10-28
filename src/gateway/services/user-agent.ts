import { UAParser } from 'ua-parser-js'

export type ParsedUserAgent = {
  browser: string | null
  os: string | null
  formatted: string
}

const OS_DISPLAY_NAMES: Record<string, string> = {
  'Mac OS': 'macOS',
  'Chrome OS': 'ChromeOS',
}

export function parseUserAgent(userAgent: string): ParsedUserAgent {
  const result = UAParser(userAgent)
  const browser = result.browser.name ?? null
  const rawOs = result.os.name ?? null
  const os = rawOs ? (OS_DISPLAY_NAMES[rawOs] ?? rawOs) : null

  let formatted = 'Unknown'
  if (browser && os) {
    formatted = `${browser} (${os})`
  } else if (browser) {
    formatted = browser
  } else if (os) {
    formatted = os
  }

  return { browser, os, formatted }
}
