import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { buildSchema, getNamedType, isLeafType, isNonNullType } from 'graphql'
import type { QueryPlanner as QueryPlannerClass } from '@graphql-hive/router-query-planner'

type PlannerModule = { QueryPlanner: typeof QueryPlannerClass }

const loadRuntimePlanner = async (): Promise<PlannerModule> => {
  const runtimeRequire = createRequire(import.meta.resolve('@graphql-hive/router-runtime'))
  const plannerPath = runtimeRequire.resolve('@graphql-hive/router-query-planner')
  return (await import(pathToFileURL(plannerPath).href)) as PlannerModule
}

/**
 * Load the query planner the router runtime uses and plan one query against
 * the supergraph. The planner is a native module that loads lazily on the
 * first request, so without this a missing binary leaves every pod Ready
 * while every query fails.
 */
export const verifyQueryPlanner = async (
  supergraphSdl: string,
  loadPlanner: () => Promise<PlannerModule> = loadRuntimePlanner
): Promise<string> => {
  const { QueryPlanner } = await loadPlanner()
  const planner = new QueryPlanner(supergraphSdl)
  const queryType = buildSchema(planner.consumerSchema).getQueryType()
  const field = Object.values(queryType?.getFields() ?? {}).find(
    (f) => !f.args.some((a) => isNonNullType(a.type))
  )
  if (!field) {
    throw new Error('Supergraph has no Query field without required arguments to plan')
  }

  const selection = isLeafType(getNamedType(field.type))
    ? field.name
    : `${field.name} { __typename }`
  const plan = planner.plan(`query ReadinessCheck { ${selection} }`, 'ReadinessCheck', new Set(), 0)
  if (!plan.node) {
    throw new Error(`Query planner returned an empty plan for Query.${field.name}`)
  }
  return field.name
}
