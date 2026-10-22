/**
 * On-disk supergraph snapshot.
 *
 * `supergraph/supergraph.graphql` is the SDL every replica serves and
 * `supergraph/paths.json` records the OpenAPI paths it was composed from.
 * The runtime reads both; the drift check compares the recorded paths with
 * the live discovery document.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Discovery document serving every API group/version spec */
export const OPENAPI_DISCOVERY_PATH = '/openapi/v3'

export interface PathsManifest {
  paths: string[]
}

/** Manifest that sits next to the SDL and names the paths it was built from. */
export const pathsManifestPath = (sdlPath: string): string => join(dirname(sdlPath), 'paths.json')

export const readSnapshotPaths = (sdlPath: string): string[] => {
  const manifest = JSON.parse(readFileSync(pathsManifestPath(sdlPath), 'utf8')) as PathsManifest
  if (!Array.isArray(manifest.paths) || manifest.paths.some((path) => typeof path !== 'string')) {
    throw new Error(`${pathsManifestPath(sdlPath)} does not contain a string paths array`)
  }
  return manifest.paths
}

export interface PathDiff {
  added: string[]
  removed: string[]
}

/** Paths in the live document that the snapshot lacks, and the reverse. */
export const diffSnapshotPaths = (committed: string[], live: string[]): PathDiff => {
  const before = new Set(committed)
  const after = new Set(live)
  return {
    added: [...after].filter((path) => !before.has(path)).sort(),
    removed: [...before].filter((path) => !after.has(path)).sort(),
  }
}

/**
 * Write the SDL and its path manifest. Both files are sorted so an unchanged
 * environment produces a byte-identical snapshot and no pull request.
 */
export const writeSnapshot = (sdlPath: string, sdl: string, paths: string[]): void => {
  mkdirSync(dirname(sdlPath), { recursive: true })
  writeFileSync(sdlPath, sdl.endsWith('\n') ? sdl : `${sdl}\n`)
  const manifest: PathsManifest = { paths: [...new Set(paths)].sort() }
  writeFileSync(pathsManifestPath(sdlPath), `${JSON.stringify(manifest, null, 2)}\n`)
}
