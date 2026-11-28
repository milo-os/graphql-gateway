import { Counter, register } from 'prom-client'
import type { CallerVerdict } from '@/gateway/auth/caller'

const CALLER_CHECKS_METRIC = 'graphql_gateway_caller_checks_total'

// Counts every token check on a GraphQL request, including the ones AUTH_MODE=log
// lets through, so tokenless traffic can be measured before enforcing. Reuse an
// existing metric so a module reload (tests, dev) doesn't throw on duplicate
// registration.
const checks =
  (register.getSingleMetric(CALLER_CHECKS_METRIC) as Counter<'verdict' | 'enforced'>) ??
  new Counter({
    name: CALLER_CHECKS_METRIC,
    help: 'Token checks on GraphQL requests by verdict, and whether a failed check was refused.',
    labelNames: ['verdict', 'enforced'],
  })

export const countCallerCheck = (verdict: CallerVerdict, enforced: boolean): void => {
  checks.inc({ verdict, enforced: String(enforced) })
}
