import { readFileSync } from 'node:fs'
import { QueryPlanner } from '@graphql-hive/router-query-planner'
import { buildSchema, getNamedType, isLeafType, isNonNullType } from 'graphql'

const supergraph = readFileSync('/app/supergraph/supergraph.graphql', 'utf8')
const planner = new QueryPlanner(supergraph)
const schema = buildSchema(planner.consumerSchema)

const field = Object.values(schema.getQueryType().getFields()).find(
  (f) => !f.args.some((a) => isNonNullType(a.type))
)
if (!field) {
  console.error('no Query field without required arguments to plan')
  process.exit(1)
}

const selection = isLeafType(getNamedType(field.type)) ? field.name : `${field.name} { __typename }`
const plan = planner.plan(`query Smoke { ${selection} }`, 'Smoke', new Set(), 0)
if (plan?.kind !== 'QueryPlan' || !plan.node) {
  console.error(`empty plan for Query.${field.name}: ${JSON.stringify(plan)}`)
  process.exit(1)
}

console.log(`planned Query.${field.name}: ${plan.node.kind}`)
