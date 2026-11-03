# GraphQLGatewayRequestsFailing

## Alert description

More than half of the GraphQL requests to the gateway returned a 5xx over the last 30 minutes, with at least 3 failures. It is counted at the HTTP layer by `graphql_gateway_http_responses_total`, so it sees failures from any stage, including ones the router runtime raises before execution.

**Critical** fires after the condition holds for 10 minutes.

## Impact

Portal features that read through the gateway show errors or no data. Pods can stay Ready while this fires.

## Investigation

### 1. Find the error in the gateway logs

```sh
kubectl logs -n graphql-gateway -l app.kubernetes.io/name=graphql-gateway --tail=100 | grep -A3 ERR
```

| Error                                                                  | Cause                                                                                                                                                                   |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Cannot find native binding` from `@graphql-hive/router-query-planner` | The image cannot load the native query planner, for example an Alpine base. The boot check should now stop such a pod turning Ready, so look for a pod that predates it |
| `Failed to plan query`                                                 | The committed supergraph and the query planner disagree; check the last supergraph compose PR                                                                           |
| Errors naming a subgraph                                               | Downstream API failure; see [subgraph-errors](subgraph-errors.md)                                                                                                       |

### 2. Check what changed

```promql
count by (image) (kube_pod_container_info{namespace="graphql-gateway", container="graphql-gateway"})
```

If the failures began with a new image, roll forward with a fix, or release the previous good version again.

## Background

datum-cloud/infra#8476: the query planner could not load on Alpine, every request returned 500 for 15 hours, and no existing metric counted it.
