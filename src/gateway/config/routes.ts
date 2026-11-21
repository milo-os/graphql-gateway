import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import yaml from 'yaml'
import type { ParentResource } from '@/gateway/types'

const ROOT_DIR = process.cwd()

// Load parent resources configuration from YAML
const parentResourcesPath = resolve(ROOT_DIR, 'config/resources/parent-resources.yaml')
export const parentResources = yaml.parse(
  readFileSync(parentResourcesPath, 'utf8')
) as ParentResource[]

// Build a set of valid parent resource combinations for fast lookup
// Format: "apiGroup/version/kind" (kind in lowercase)
export const validParentResources = new Set<string>(
  parentResources.map((p) => `${p.apiGroup}/${p.version}/${p.kind.toLowerCase()}`)
)

// Pre-compute scoped endpoint patterns for documentation
export const scopedEndpoints = Array.from(validParentResources).map((key) => {
  const [apiGroup, version, kind] = key.split('/')
  return `/${apiGroup}/${version}/${kind}s/{name}/graphql`
})

// Build valid kinds from configuration (pluralized, lowercase)
export const validKindsPlural = [
  ...new Set(Array.from(validParentResources).map((key) => key.split('/')[2] + 's')),
]

// URL pattern for scoped resources - built dynamically from config
export const SCOPED_RESOURCE_PATTERN =
  validKindsPlural.length > 0
    ? new RegExp(`^/([^/]+)/([^/]+)/(${validKindsPlural.join('|')})/([^/]+)/graphql$`)
    : null

// All available endpoints for documentation
// /metrics is left out: it is served on the metrics port only.
export const availableEndpoints = ['/graphql', '/healthcheck', '/readiness', ...scopedEndpoints]
