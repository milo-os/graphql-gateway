/**
 * Compose the supergraph snapshot from a live Kubernetes API server.
 *
 * Usage:
 *   tsx scripts/compose-supergraph.ts \
 *     --server https://api.staging.env.datum.net \
 *     --token "$DATUM_TOKEN" \
 *     --endpoint 'https://milo-apiserver.datum-system.svc.cluster.local:6443{context.headers.x-resource-endpoint-prefix}'
 *
 * The workflow `.github/workflows/compose-supergraph.yaml` runs this daily
 * against staging and opens a PR when the SDL changes.
 */
import { resolve } from 'node:path'
import { composeSupergraph } from '../src/gateway/runtime/compose'
import { writeSnapshot } from '../src/gateway/runtime/supergraph-snapshot'

const DEFAULT_OUTPUT = 'supergraph/supergraph.graphql'

const usage = `Usage: tsx scripts/compose-supergraph.ts --server <url> [options]

Options:
  --server <url>        API server serving /openapi/v3 (required)
  --token <token>       Bearer token for the API server (default: $DATUM_TOKEN)
  --endpoint <template> URL template baked into the SDL transports
                        (default: <server>{context.headers.x-resource-endpoint-prefix})
  --output <path>       Snapshot path (default: ${DEFAULT_OUTPUT})
  --concurrency <n>     Concurrent spec fetches (default: 5)
`

interface Args {
  server: string
  token: string
  endpoint?: string
  output: string
  concurrency: number
}

const parseArgs = (argv: string[]): Args => {
  const values = new Map<string, string>()
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    if (!flag.startsWith('--')) throw new Error(`Unexpected argument: ${flag}`)
    const value = argv[i + 1]
    if (value === undefined) throw new Error(`Missing value for ${flag}`)
    values.set(flag.slice(2), value)
    i += 1
  }

  const server = values.get('server')
  if (!server) throw new Error('--server is required')

  const token = values.get('token') ?? process.env.DATUM_TOKEN
  if (!token) throw new Error('--token or DATUM_TOKEN is required')

  const concurrency = Number(values.get('concurrency') ?? 5)
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error('--concurrency must be a positive integer')
  }

  return {
    server,
    token,
    endpoint: values.get('endpoint'),
    output: values.get('output') ?? DEFAULT_OUTPUT,
    concurrency,
  }
}

/** Attach the bearer token to every discovery and spec request. */
const authorizedFetch = (token: string): typeof fetch => {
  return (input, init) => {
    const headers = new Headers(init?.headers)
    headers.set('Authorization', `Bearer ${token}`)
    headers.set('Accept', 'application/json')
    return fetch(input, { ...init, headers })
  }
}

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2))

  console.log(`Composing from ${args.server} (concurrency: ${args.concurrency})`)
  const { sdl, paths } = await composeSupergraph({
    server: args.server,
    fetch: authorizedFetch(args.token),
    endpoint: args.endpoint,
    concurrency: args.concurrency,
  })

  const output = resolve(process.cwd(), args.output)
  writeSnapshot(output, sdl, paths)
  console.log(`Wrote ${sdl.length} bytes of SDL and ${paths.length} paths to ${output}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  if (error instanceof Error && error.message.startsWith('--')) console.error(usage)
  process.exit(1)
})
