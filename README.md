# GraphQL Gateway for Milo APIServer

This project provides a **GraphQL gateway** that sits in front of Milo APIServer REST/OpenAPI services and exposes a unified GraphQL API. It uses **Hive Gateway** with dynamic supergraph composition from OpenAPI specs at runtime.

> **Status**: This gateway is in an **initial, non‑production stage**. It is intended **only for local testing by the Datum team** and **is not production ready**.

## Architecture

- **Dynamic Supergraph Composition**: The gateway dynamically fetches OpenAPI specs from the Milo APIServer and composes a unified GraphQL supergraph at runtime.
- **mTLS Authentication**: Uses client certificates (mTLS) to authenticate with the Kubernetes API server.
- **Polling**: The supergraph is recomposed periodically based on the `POLLING_INTERVAL` environment variable.

### What Hive Gateway is

- **Hive Gateway**: a production-ready GraphQL gateway/router from the GraphQL Hive ecosystem.
- It:
  - Dynamically composes a supergraph from OpenAPI specs fetched from Milo APIServer.
  - Executes incoming GraphQL operations by delegating to the underlying Milo APIs.
  - Handles concerns like header propagation, TLS, caching, and observability.

### Environment Variables

| Variable              | Description                                        | Default              |
| --------------------- | -------------------------------------------------- | -------------------- |
| `PORT`                | Port the gateway listens on                        | `4000`               |
| `KUBECONFIG`          | Path to kubeconfig file for K8s authentication     | Required             |
| `POLLING_INTERVAL`    | Interval (ms) between supergraph recomposition     | `1_200_000` (20 min) |
| `LOGGING`             | Log level (`debug`, `info`, `warn`, `error`)       | `info`               |
| `NODE_EXTRA_CA_CERTS` | Path to CA certificate for trusting K8s API server | Required for mTLS    |

### Project Scripts

Defined in `package.json`:

- **`npm run build`**
  - Compiles TypeScript source code to JavaScript.

- **`npm run dev`**
  - Runs the gateway in development mode with hot reloading.

- **`npm run start`**
  - Runs the compiled gateway from `dist/`.

- **`npm run lint`**
  - Runs ESLint on the codebase.

### Local Testing

A comprehensive local testing script is provided at `scripts/local-test.sh`. This script:

1. Verifies the correct kubectl context is active
2. Generates client certificates using cert-manager
3. Creates a local kubeconfig with mTLS credentials
4. Sets up port-forwarding to the Milo APIServer
5. Runs the gateway locally

**Prerequisites**:

- `kubectl` configured with access to the staging cluster
- `cert-manager` installed in the cluster
- Entry in `/etc/hosts`: `127.0.0.1 milo-apiserver`

**Usage**:

```bash
./scripts/local-test.sh
```

### Kubernetes Deployment

The gateway is deployed to Kubernetes using the manifests in `config/base/`. Key components:

- **deployment.yaml**: Gateway deployment with mTLS volume mounts
- **service.yaml**: ClusterIP service exposing port 4000
- **http-route.yaml**: HTTPRoute for ingress configuration
- **milo-control-plane-kubeconfig.yaml**: ConfigMap with kubeconfig template

### Querying Milo through the Gateway

- **Using the built‑in GraphQL UI**:
  - When running the gateway, it exposes a GraphQL endpoint at `http://127.0.0.1:4000/graphql`.
  - Open this URL in your browser to use the UI for exploring the schema and running queries against Milo.

- **[Client Usage Guide](docs/CLIENT_USAGE.md)**:
  - Check the detailed guide on how to setup `codegen` and use the gateway from a client application, including **Parent Resources** setup.

- **Health Endpoints**:
  - `/healthcheck` - Liveness probe (fails once the composition worker's restart schedule is exhausted)
  - `/readiness` - Readiness probe (K8s auth initialized and the supergraph composed at least once)
