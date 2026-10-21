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

`graphql_gateway_fetch_duration` only covers federated subgraph fetches.
Gateway-local resolvers (`organizationMembers`, `organizations`, `projects`,
`users`, `sessions`, quota, contacts) call milo through a separate fetch that
records `graphql_gateway_local_fetch_duration_seconds` and
`graphql_gateway_local_fetch_inflight`, labelled by K8s resource plural:

```promql
histogram_quantile(0.95, sum by (le, resource) (rate(graphql_gateway_local_fetch_duration_seconds_bucket[10m])))
max by (resource) (max_over_time(graphql_gateway_local_fetch_inflight[10m]))
```

Every call on this path has a deadline (`UPSTREAM_TIMEOUT_MS`, 10s by
default): response headers on the user-token path, the whole response on the
mTLS path used for federated subgraph calls. A call that hits it is recorded
with `status="timeout"`. In a page-level resolver the operation then fails with
`extensions.code = UPSTREAM_TIMEOUT` instead of returning an empty list;
per-item enrichment (an org's display name on a project row, a contact on a
membership row) still degrades that item to null by design. A rising timeout
count with normal milo-side latency means a hung connection, not a slow
apiserver:

```promql
sum by (resource) (rate(graphql_gateway_local_fetch_duration_seconds_count{status="timeout"}[10m]))
```

A paginated list page that fails for any other reason also surfaces as an
error rather than an empty page. The codes a client can branch on:

| `extensions.code`  | Meaning                                                               | Client recovery                    |
| ------------------ | --------------------------------------------------------------------- | ---------------------------------- |
| `UPSTREAM_TIMEOUT` | No response headers within the deadline                               | Retry                              |
| `UPSTREAM_ERROR`   | Milo answered a non-OK status (`extensions.status`) or the call threw | Show the error; retry if transient |
| `CURSOR_EXPIRED`   | The continue token expired from the apiserver watch cache (410)       | Restart paging from the first page |

Local operations run through `graphql.execute`, which resolves sibling query
fields (including aliases) concurrently. Organization, project and billing
lookups are deduped per request and share one concurrency budget
(`REQUEST_LOADER_CONCURRENCY`, 8 upstream requests per operation), so aliased
`project`/`organization` fields no longer show one fetch per alias. Because of
that budget, `graphql_gateway_local_fetch_inflight` saturating that ceiling is
the gateway's own limit, not upstream queuing. If in-flight stays at the ceiling
while each call's gateway-side duration is well above what milo reports for it,
the requests are queuing upstream (for example API Priority and Fairness on the
apiserver), not in the gateway.

An operation that mixes gateway-local and federated top-level fields is routed
to the router and fails; `graphql_gateway_mixed_operations_total` counts those
attempts, and each attempt logs `Mixed local and federated operation` with the
operation name (or `anonymous`).

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
