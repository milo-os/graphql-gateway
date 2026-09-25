/**
 * Shared Kubernetes type alignment
 *
 * Every k8s API group's OpenAPI spec embeds its own copy of the apimachinery
 * types (ListMeta, ObjectMeta, Status, ...). Each API server builds those from
 * whatever k8s.io/apimachinery version it vendors, so the copies drift when
 * one server upgrades before the others. For example, apimachinery added
 * `ListMeta.shardInfo`, and the activity server served it before the other
 * servers did.
 *
 * These types have no @key, so federation treats them as value types. Any
 * field that only some subgraphs define is unsatisfiable when the parent
 * object comes from a subgraph without it, and composition fails for the
 * entire supergraph.
 *
 * To keep one server's upgrade from taking down the whole gateway, we trim
 * each shared apimachinery output type down to the fields that every subgraph
 * defining it agrees on. A field becomes visible once all servers serve it.
 *
 * This file is imported by the compose worker, so it must follow the same
 * import restrictions (no `@/` path aliases).
 */
import { type GraphQLSchema, isObjectType, isInterfaceType } from 'graphql'
import { mapSchema, MapperKind } from '@graphql-tools/utils'

const SHARED_TYPE_PREFIX = 'io_k8s_apimachinery_'

export interface NamedSubgraph {
  name: string
  schema: GraphQLSchema
}

export interface AlignResult<T extends NamedSubgraph> {
  subgraphs: T[]
  /** `Type.field` -> names of the subgraphs that defined it before trimming */
  removed: Map<string, string[]>
}

const isShared = (typeName: string) => typeName.startsWith(SHARED_TYPE_PREFIX)

export function alignSharedTypes<T extends NamedSubgraph>(subgraphs: T[]): AlignResult<T> {
  // typeName -> fieldName -> subgraphs that define it
  const fieldOwners = new Map<string, Map<string, string[]>>()
  // typeName -> number of subgraphs that define the type
  const typeCount = new Map<string, number>()

  for (const { name, schema } of subgraphs) {
    for (const type of Object.values(schema.getTypeMap())) {
      if (!isShared(type.name) || !(isObjectType(type) || isInterfaceType(type))) continue
      typeCount.set(type.name, (typeCount.get(type.name) ?? 0) + 1)
      let fields = fieldOwners.get(type.name)
      if (!fields) {
        fields = new Map()
        fieldOwners.set(type.name, fields)
      }
      for (const fieldName of Object.keys(type.getFields())) {
        const owners = fields.get(fieldName) ?? []
        owners.push(name)
        fields.set(fieldName, owners)
      }
    }
  }

  const removed = new Map<string, string[]>()
  for (const [typeName, fields] of fieldOwners) {
    const count = typeCount.get(typeName)!
    for (const [fieldName, owners] of fields) {
      if (owners.length < count) removed.set(`${typeName}.${fieldName}`, owners)
    }
  }

  if (removed.size === 0) return { subgraphs, removed }

  const trimField = (_config: unknown, fieldName: string, typeName: string) =>
    removed.has(`${typeName}.${fieldName}`) ? null : undefined

  const aligned = subgraphs.map((subgraph) => ({
    ...subgraph,
    schema: mapSchema(subgraph.schema, {
      [MapperKind.OBJECT_FIELD]: trimField,
      [MapperKind.INTERFACE_FIELD]: trimField,
    }),
  }))

  return { subgraphs: aligned, removed }
}
