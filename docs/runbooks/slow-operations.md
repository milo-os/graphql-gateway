# GraphQLGatewaySlowOperation

## Alert description

A single GraphQL operation (identified by the `operationName` label) has a
p95 response time above 2s, sustained for 15 minutes. This fires per
operation, so the alert tells you exactly which query is slow rather than
an aggregate gateway-wide number.

## Impact

Users of the affected operation see slow page loads or spinners. Other
operations are typically unaffected unless the slow one is exhausting a
shared resource (connection pool, event loop).

## Investigation

### 1. Confirm which operation and how bad

```promql
histogram_quantile(0.95, sum by (le, operationName) (rate(graphql_envelop_request_duration_bucket[10m])))
```

Or use the "P95 request duration by operation" / "Average request duration
by operation" panels on the Hive Gateway dashboard.

### 2. Check for a per-item fan-out

Most slow operations in this gateway come from resolving a list and then
firing one upstream request per item (per organization, per project, per
user) instead of batching. Look at fetch volume and duration by URL for the
affected window:

```promql
topk(20, sum by (url) (rate(graphql_gateway_fetch_duration_count[10m])))
```

Many distinct URLs that differ only by an ID (org name, project name, user
ID) landing in the same short window is the fan-out signature. Compare
`graphql_gateway_subgraph_execute_duration_sum` for the affected pod against
the sum of the individual fetch durations in that window - if they're close,
the fan-out is running sequentially rather than concurrently.

### 3. Check list size

A large organization or project list will always take longer than a small
one, even with an efficient resolver - more upstream calls, more relative
latency. This isn't a bug by itself, but it changes how much headroom the
alert threshold has for that customer.

### 4. Check `src/gateway/graphql/resolvers/organizations.ts`

This is where the `Organizations` and `Projects` operations are resolved.
See [#46](https://github.com/milo-os/graphql-gateway/issues/46) for a
description of the specific patterns found there: a sequential await
between two independent enrichment stages in `enrichProjects()`, and
per-item `Organization.projects`/`Organization.members` resolvers with no
batching across siblings in a list.

## Resolution

- If the cause matches the patterns in #46, see that issue for the
  suggested fix (parallelize the enrichment stages, add batching for the
  per-item resolvers).
- If it's simply a large org/project list, no action needed beyond
  confirming the alert threshold still makes sense.

## Metric

```promql
histogram_quantile(0.95, sum by (le, operationName) (rate(graphql_envelop_request_duration_bucket[$__rate_interval])))
```

Labels: `operationName`, `operationType`, `pod`
