/**
 * Supergraph snapshot loading and drift detection.
 *
 * The SDL is composed in CI (`scripts/compose-supergraph.ts`) and committed to
 * `supergraph/supergraph.graphql`, so every replica serves the same bytes and
 * boot no longer depends on a full composition cycle.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'graphql'
import { env } from '@/gateway/config'
import { getK8sServer, getMTLSFetch } from '@/gateway/auth'
import { log } from '@/shared/utils'
import {
  OPENAPI_DISCOVERY_PATH,
  diffSnapshotPaths,
  readSnapshotPaths,
  type PathDiff,
} from './supergraph-snapshot'

/** Committed SDL served by the gateway. */
let supergraphSdl = ''
let isReady = false

const snapshotPath = (): string =>
  env.supergraphPath || resolve(process.cwd(), 'supergraph/supergraph.graphql')

/**
 * Load the committed SDL. Throws when the file is missing, empty, or not
 * parseable as SDL: that is a broken image, and failing at boot is better
 * than reporting ready and failing every request.
 */
export const loadSupergraphSnapshot = (path = snapshotPath()): string => {
  const sdl = readFileSync(path, 'utf8')
  if (sdl.trim().length === 0) {
    throw new Error(`Supergraph snapshot at ${path} is empty`)
  }
  try {
    parse(sdl, { noLocation: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Supergraph snapshot at ${path} is not valid SDL: ${message}`)
  }
  return sdl
}

const fetchLivePaths = async (): Promise<string[]> => {
  const response = await getMTLSFetch()(`${getK8sServer()}${OPENAPI_DISCOVERY_PATH}`)
  if (!response.ok) {
    throw new Error(`OpenAPI discovery failed: ${response.status} ${response.statusText}`)
  }
  const document = (await response.json()) as { paths?: Record<string, unknown> }
  if (!document.paths) throw new Error('OpenAPI discovery document has no paths')
  return Object.keys(document.paths)
}

/**
 * Compare the paths recorded next to the committed SDL with the live
 * discovery document. A difference means a Milo API change is waiting for the
 * next snapshot run; it is a warning, never a startup failure.
 */
export const checkSnapshotDrift = async (path = snapshotPath()): Promise<PathDiff | null> => {
  try {
    const live = await fetchLivePaths()
    const committed = readSnapshotPaths(path)
    const diff = diffSnapshotPaths(committed, live)

    if (diff.added.length > 0 || diff.removed.length > 0) {
      log.warn(
        'Supergraph snapshot is out of date with the live OpenAPI paths; the next compose run will open a PR',
        { added: diff.added, removed: diff.removed, snapshot: path }
      )
    } else {
      log.info('Supergraph snapshot matches the live OpenAPI paths', { paths: live.length })
    }
    return diff
  } catch (error) {
    log.warn('Could not check supergraph snapshot drift', {
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

/**
 * Load the snapshot and mark the gateway ready. The drift check runs in the
 * background so a slow or unreachable API server cannot delay readiness.
 */
export const initializeGateway = async (): Promise<void> => {
  const path = snapshotPath()
  supergraphSdl = loadSupergraphSnapshot(path)
  isReady = true
  log.info('Supergraph snapshot loaded', { path, bytes: supergraphSdl.length })
  void checkSnapshotDrift(path)
}

/** The committed SDL, handed to Hive Gateway as the already-resolved schema. */
export const getSupergraph = (): string => supergraphSdl

/** True once the committed SDL has been read at boot. */
export const isSupergraphReady = (): boolean => isReady
