import {
  parse,
  extendSchema,
  execute as defaultExecute,
  Kind,
  type GraphQLSchema,
  type DocumentNode,
  type OperationDefinitionNode,
  type FieldNode,
} from 'graphql'
import { addResolversToSchema } from '@graphql-tools/schema'
import type { Plugin } from 'graphql-yoga'
import type { IResolvers } from '@graphql-tools/utils'
import { additionalTypeDefs } from './typeDefs'
import { additionalResolvers } from './resolvers'
import { attachRequestLoaders } from './resolvers/loaders'

/**
 * Top-level Query / Mutation field names that are resolved locally by the
 * gateway and should NOT be planned by the Hive Router.  Derived from the
 * resolver map so the two stay in sync.
 */
const resolverMap = additionalResolvers as {
  Query?: Record<string, unknown>
  Mutation?: Record<string, unknown>
}
const LOCAL_FIELDS: Readonly<Record<'query' | 'mutation', ReadonlySet<string>>> = {
  query: new Set(Object.keys(resolverMap.Query ?? {})),
  mutation: new Set(Object.keys(resolverMap.Mutation ?? {})),
}

/**
 * Top-level introspection fields. When every top-level selection on an
 * operation is one of these (or a local field — `isLocallyExecutable`
 * accepts a mix), we run the whole operation through the default GraphQL
 * executor against the schema-with-local-extensions, so introspection
 * clients see both federated and gateway-local types.
 */
const INTROSPECTION_FIELDS: ReadonlySet<string> = new Set([
  '__schema',
  '__type',
  '__typename',
])

/**
 * Returns true when every top-level selection on the operation can be
 * served by the default GraphQL executor against the local-extended
 * schema — i.e. each top-level field is either a local resolver or an
 * introspection meta-field. Operations that mix local + federated fields
 * fall back to the router (which will fail — we don't currently support
 * mixed operations).
 */
export const isLocallyExecutable = (doc: DocumentNode, opName?: string | null): boolean => {
  const op = doc.definitions.find(
    (d): d is OperationDefinitionNode =>
      d.kind === Kind.OPERATION_DEFINITION &&
      (d.operation === 'query' || d.operation === 'mutation') &&
      (!opName || d.name?.value === opName)
  )
  if (!op) return false

  const localFields = LOCAL_FIELDS[op.operation as 'query' | 'mutation']

  const topLevelFields = op.selectionSet.selections.filter(
    (s): s is FieldNode => s.kind === Kind.FIELD
  )
  if (topLevelFields.length === 0) return false

  return topLevelFields.every(
    (f) => INTROSPECTION_FIELDS.has(f.name.value) || (localFields?.has(f.name.value) ?? false)
  )
}

/**
 * Adds gateway-local fields (e.g. parseUserAgent, geolocateIP, sessions,
 * deleteSession) to the unified graph schema produced by the Hive Router
 * and routes both their execution and any introspection of them through
 * the default GraphQL executor.
 *
 * Two phases:
 *
 * 1. `onSchemaChange` – extends the router's schema with our type defs +
 *    resolvers so that validation succeeds for local fields and so that
 *    introspection (when run against this extended schema) returns the
 *    union of federated + local types. The Hive Router
 *    (`@graphql-hive/router-runtime`'s `unifiedGraphHandler`) ignores
 *    `additionalTypeDefs` / `additionalResolvers` on `createGatewayRuntime`
 *    config, so we have to do it ourselves here.
 *
 * 2. `onExecute` – for operations whose top-level fields are all local
 *    resolvers, all introspection meta-fields, or a mix of the two,
 *    swap the executor for the default `graphql.execute`. Otherwise the
 *    router would try to plan the operation against the supergraph SDL
 *    (which knows nothing about local fields) and either fail with
 *    "Field 'X' not found in type 'Query'" for local execution or return
 *    an SDL-only introspection result that hides the local schema.
 */
export const useGatewayLocalSchema = (): Plugin => {
  const ast = parse(additionalTypeDefs)
  const extended = new WeakSet<GraphQLSchema>()

  return {
    onSchemaChange({ schema, replaceSchema }) {
      if (!schema || extended.has(schema)) return

      const withTypes = extendSchema(schema, ast, {
        assumeValid: true,
        assumeValidSDL: true,
      })
      const withResolvers = addResolversToSchema({
        schema: withTypes,
        resolvers: additionalResolvers as IResolvers,
      })

      extended.add(withResolvers)
      replaceSchema(withResolvers)
    },

    onExecute({ args, setExecuteFn }) {
      // One loader bag per GraphQL context, which yoga scopes to one inbound
      // request. Aliased fields in the same operation share deduped lookups.
      attachRequestLoaders(args.contextValue)
      if (isLocallyExecutable(args.document, args.operationName)) {
        setExecuteFn(defaultExecute)
      }
    },
  }
}
