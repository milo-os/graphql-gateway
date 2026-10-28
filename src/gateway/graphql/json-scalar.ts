import { GraphQLScalarType, Kind } from 'graphql'
import type { ObjectValueNode } from 'graphql'

const GraphQLJSON = new GraphQLScalarType({
  name: 'JSON',
  description: 'Arbitrary JSON value',

  serialize(value: unknown): unknown {
    return value
  },

  parseValue(value: unknown): unknown {
    return value
  },

  parseLiteral(ast): unknown {
    switch (ast.kind) {
      case Kind.STRING:
        return ast.value
      case Kind.BOOLEAN:
        return ast.value
      case Kind.INT:
        return parseInt(ast.value, 10)
      case Kind.FLOAT:
        return parseFloat(ast.value)
      case Kind.OBJECT:
        return parseObject(ast)
      case Kind.LIST:
        return ast.values.map((v) => GraphQLJSON.parseLiteral(v, {}))
      case Kind.NULL:
        return null
      default:
        return undefined
    }
  },
})

function parseObject(ast: ObjectValueNode): Record<string, unknown> {
  const value: Record<string, unknown> = {}
  for (const field of ast.fields) {
    value[field.name.value] = GraphQLJSON.parseLiteral(field.value, {})
  }
  return value
}

export default GraphQLJSON
