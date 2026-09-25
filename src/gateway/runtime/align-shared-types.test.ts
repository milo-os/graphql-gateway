import { describe, expect, it } from 'vitest'
import { buildSchema, type GraphQLObjectType } from 'graphql'
import { alignSharedTypes } from './align-shared-types'

const listMeta = 'io_k8s_apimachinery_pkg_apis_meta_v1_ListMeta'

const subgraph = (name: string, listMetaFields: string, extra = '') => ({
  name,
  schema: buildSchema(/* GraphQL */ `
    type Query { list: ${listMeta} }
    type ${listMeta} { ${listMetaFields} }
    ${extra}
  `),
})

const fieldsOf = (sub: { schema: ReturnType<typeof buildSchema> }, type: string) =>
  Object.keys((sub.schema.getType(type) as GraphQLObjectType).getFields()).sort()

describe('alignSharedTypes', () => {
  it('drops apimachinery fields that only some subgraphs define', () => {
    const { subgraphs, removed } = alignSharedTypes([
      subgraph(
        'ACTIVITY',
        'continue: String resourceVersion: String shardInfo: ShardInfo',
        'type ShardInfo { selector: String }'
      ),
      subgraph('SERVICES', 'continue: String resourceVersion: String'),
    ])

    expect(fieldsOf(subgraphs[0], listMeta)).toEqual(['continue', 'resourceVersion'])
    expect(fieldsOf(subgraphs[1], listMeta)).toEqual(['continue', 'resourceVersion'])
    expect([...removed]).toEqual([[`${listMeta}.shardInfo`, ['ACTIVITY']]])
  })

  it('returns the original subgraphs when shared types already agree', () => {
    const input = [
      subgraph('A', 'continue: String'),
      subgraph('B', 'continue: String'),
    ]
    const { subgraphs, removed } = alignSharedTypes(input)

    expect(removed.size).toBe(0)
    expect(subgraphs).toBe(input)
  })

  it('leaves non-apimachinery types alone', () => {
    const extraA = 'type com_example_Thing { a: String b: String } extend type Query { thing: com_example_Thing }'
    const extraB = 'type com_example_Thing { a: String } extend type Query { thing: com_example_Thing }'
    const { subgraphs, removed } = alignSharedTypes([
      subgraph('A', 'continue: String', extraA),
      subgraph('B', 'continue: String', extraB),
    ])

    expect(removed.size).toBe(0)
    expect(fieldsOf(subgraphs[0], 'com_example_Thing')).toEqual(['a', 'b'])
  })
})
