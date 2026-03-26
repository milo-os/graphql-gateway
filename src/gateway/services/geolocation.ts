import { Reader } from '@maxmind/geoip2-node'
import type ReaderModel from '@maxmind/geoip2-node/dist/src/readerModel'
import { log } from '@/shared/utils'

let reader: ReaderModel | null = null

export async function initGeolocation(dbPath: string): Promise<void> {
  reader = await Reader.open(dbPath)
  log.info('MaxMind GeoIP database loaded', { path: dbPath })
}

export function isGeolocationReady(): boolean {
  return reader !== null
}

export function lookupIp(ipAddress: string): string | null {
  if (!reader) {
    log.warn('MaxMind reader not initialized, skipping geolocation lookup')
    return null
  }

  try {
    const result = reader.city(ipAddress)
    const city = result.city?.names?.en
    const country = result.country?.names?.en

    if (city && country) return `${city}, ${country}`
    if (country) return country
    if (city) return city
    return null
  } catch (error) {
    log.warn('GeoIP lookup failed', {
      ipAddress,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}
