import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { verifyQueryPlanner } from './query-planner-check'

const committedSupergraph = (): string =>
  readFileSync(resolve(process.cwd(), 'supergraph/supergraph.graphql'), 'utf8')

describe('verifyQueryPlanner', () => {
  it('plans a query against the committed supergraph', async () => {
    await expect(verifyQueryPlanner(committedSupergraph())).resolves.toMatch(/\S/)
  })

  it('rejects when the native planner cannot load', async () => {
    const missingBinding = () => Promise.reject(new Error('Cannot find native binding'))

    await expect(verifyQueryPlanner('', missingBinding)).rejects.toThrow(
      'Cannot find native binding'
    )
  })
})
