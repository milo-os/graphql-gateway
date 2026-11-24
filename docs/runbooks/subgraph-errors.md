# GraphQLGatewaySubgraphErrors / GraphQLGatewaySubgraphErrorsSustained

## Alert description

The graphql-gateway is failing to execute requests against one or more
downstream subgraph APIs. The `subgraphName` label identifies which API
is affected (e.g., `APIS_RESOURCEMANAGER_MILOAPIS_COM_V1ALPHA1`).

**Warning** fires after any errors sustained for 5 minutes.
**Critical** fires after >5 errors in 15 minutes, sustained for 10 minutes.

Both count only errors from callers that sent an `Authorization` header.
A request without credentials is rejected by milo with 401/403, which
says nothing about the gateway's health, and a scanner probing the
public endpoint would otherwise page on it. Those errors are still
recorded with `authenticated="false"`; a spike there is worth a look as
a security signal, not an availability one.

## Impact

Users will see errors or missing data for the affected subgraph. For
example, if `APIS_RESOURCEMANAGER_MILOAPIS_COM_V1ALPHA1` is failing,
organization membership queries will return errors.

## Investigation

### 1. Check the graphql-gateway logs

```sh
kubectl logs -n graphql-gateway -l app.kubernetes.io/name=graphql-gateway --tail=50 | grep ERR
```

Look for the error message. Common errors:

| Error | Cause |
|---|---|
| `unable to verify the first certificate` | TLS CA trust issue |
| `ECONNREFUSED` | Downstream API server is down |
| `ETIMEDOUT` | Network connectivity or DNS issue |
| `certificate has expired` | Expired serving cert |

### 2. TLS verification failure (`unable to verify the first certificate`)

This means Node.js cannot verify the downstream API server's TLS
certificate against its trusted CA bundle.

**Check `NODE_EXTRA_CA_CERTS` is set:**
```sh
kubectl exec -n graphql-gateway deploy/graphql-gateway -- env | grep NODE_EXTRA_CA_CERTS
```

Expected: `NODE_EXTRA_CA_CERTS=/etc/ssl/certs/datum-ca.crt`

If missing, the Flux Kustomization patches may have been overwritten by
an environment overlay. See [infra#2188](https://github.com/datum-cloud/infra/pull/2188)
for the root cause pattern.

**Verify the CA file exists in the pod:**
```sh
kubectl exec -n graphql-gateway deploy/graphql-gateway -- cat /etc/ssl/certs/datum-ca.crt | openssl x509 -noout -subject -dates
```

**Test TLS from the pod:**
```sh
kubectl exec -n graphql-gateway deploy/graphql-gateway -- node -e "
const https = require('https');
const fs = require('fs');
const ca = fs.readFileSync('/etc/ssl/certs/datum-ca.crt');
https.get({
  hostname: 'milo-apiserver.datum-system.svc.cluster.local',
  port: 6443, path: '/healthz', ca,
  cert: fs.readFileSync('/etc/kubernetes/pki/client/tls.crt'),
  key: fs.readFileSync('/etc/kubernetes/pki/client/tls.key'),
}, (res) => console.log('Status:', res.statusCode))
.on('error', (e) => console.log('Error:', e.message));
"
```

### 3. Downstream API server unavailable

Check if the milo-apiserver is running:
```sh
kubectl get pods -n datum-system -l app=milo-apiserver
```

Check the aggregated API service health:
```sh
kubectl get apiservice | grep resourcemanager
```

### 4. Certificate rotation

If certs were recently rotated (e.g., after a milo-apiserver restart),
the graphql-gateway may need a restart to pick up the new trust bundle:

```sh
kubectl rollout restart deployment/graphql-gateway -n graphql-gateway
```

## Resolution

- **Missing `NODE_EXTRA_CA_CERTS`**: Fix the Flux Kustomization patches
  in the infra repo. Use JSON patch (`op: add`, `path: /spec/patches/-`)
  to append environment-specific patches instead of replacing base patches.
- **Downstream API down**: Check milo-apiserver and the aggregated API
  service. Restart if needed.
- **Expired cert**: cert-manager CSI should auto-renew. If not, check
  the ClusterIssuer and CertificateRequest status.

## Metric

```promql
sum without (authenticated) (
  increase(graphql_gateway_subgraph_execute_errors{authenticated!="false"}[5m])
)
```

Labels: `subgraphName`, `pod`, `operationName`, `operationType`,
`authenticated`
