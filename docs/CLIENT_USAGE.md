# Client Usage Guide

This guide explains how to consume the GraphQL Gateway from a client application. It covers setting up code generation, writing queries for Kubernetes-mapped resources, and using parent-scoped endpoints.

## 1. Setup GraphQL Codegen

We recommend using [`@graphql-codegen/cli`](https://the-guild.dev/graphql/codegen) with the `client-preset` to generate strong TypeScript types for your queries and mutations.

### Installation

```bash
# Install the codegen CLI, the client preset, and graphql (peer dependency)
npm install -D @graphql-codegen/cli @graphql-codegen/client-preset graphql
```

### Configuration Example (`codegen.ts`)

Create a `codegen.ts` file in your project root:

```typescript
import type { CodegenConfig } from '@graphql-codegen/cli'
import * as dotenv from 'dotenv'

dotenv.config()

// The URL of your running GraphQL Gateway (local or remote)
const GRAPHQL_ENDPOINT = process.env.GRAPHQL_URL || 'http://localhost:4000/graphql' // or 'https://graphql.prod.env.datum.net/graphql'

const config: CodegenConfig = {
  overwrite: true,
  // Point schema to the gateway to fetch the latest schema introspection
  schema: {
    [GRAPHQL_ENDPOINT]: {
      headers: {},
    },
  },
  // Paths to your GraphQL operation files
  documents: ['./app/**/*.graphql'],
  generates: {
    './app/resources/graphql/gen/': {
      preset: 'client',
      config: {
        // Map custom scalars to TypeScript types
        scalars: {
          DateTime: 'string',
          Date: 'string',
          Time: 'string',
          JSON: 'Record<string, any>',
        },
        enumsAsTypes: true,
        skipTypename: true,
        documentMode: 'string', // recommended for smaller bundles
      },
    },
  },
}

export default config
```

### Development Workflow

1. **Write Query**: Create a `.graphql` file (e.g., `app/resources/graphql/queries/my-query.graphql`) with your operation.
2. **Run Codegen**: Execute `npm run codegen` to generate the TypeScript types.
3. **Import Types**: The generated types and document objects will now be available in `app/resources/graphql/gen/graphql.ts`.

> [!IMPORTANT]
> You must create the GraphQL query file _first_. The codegen tool scans your project for `.graphql` files, validates them against the schema, and _then_ generates the TypeScript code.

### Running the Codegen

Add a script to your `package.json` to run the codegen:

```json
{
  "scripts": {
    "codegen": "graphql-codegen --config codegen.ts"
  }
}
```

Then run the command:

```bash
npm run codegen
```

Or run it directly with `npx`:

```bash
npx graphql-codegen --config codegen.ts
```

## 2. Client Request Wrapper

To consume the generated types easily, we recommend creating a type-safe wrapper around your fetcher (e.g., `fetch` or `axios`).

**Why a wrapper?**

> [!NOTE]
> In our existing applications (like `staff-portal`), we use a custom wrapper to route GraphQL requests through our standard REST client infrastructure. This allows us to **seamlessly integrate with existing Sentry logic** for error reporting, request ID tracking, and authentication, preserving the reliability patterns we already have in place for REST endpoints.

Here is a simplified example:

```typescript
import { type TypedDocumentString } from '@/resources/graphql/gen/graphql'

const GRAPHQL_URL = process.env.GRAPHQL_URL || 'https://graphql.prod.env.datum.net/graphql'

/**
 * Execute a GraphQL query with typed document string.
 *
 * @param document - TypedDocumentString from generated operations
 * @param variables - Query variables
 */
export async function graphqlRequest<TData, TVariables>(
  document: TypedDocumentString<TData, TVariables>,
  variables?: TVariables
): Promise<TData> {
  // TypedDocumentString.toString() returns the raw query string
  const query = document.toString()

  const response = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // 'Authorization': `Bearer ${token}` // Add auth if needed
    },
    body: JSON.stringify({ query, variables }),
  })

  const json = await response.json()

  // Handle GraphQL-level errors
  if (json.errors?.length > 0) {
    const messages = json.errors.map((e: any) => e.message).join(', ')
    throw new Error(`GraphQL Error: ${messages}`)
  }

  if (!json.data) {
    throw new Error('GraphQL response missing data')
  }

  return json.data
}
```

> [!NOTE]
> This is just a reference implementation. Since the Gateway exposes a standard GraphQL introspection endpoint, you are free to use any GraphQL client (Apollo, Urql, or custom fetch wrappers) and implement your own error handling or logic as needed.

## 3. Querying Resources

The gateway automatically converts Kubernetes resources into GraphQL operations. The naming convention for operations typically follows:
`[verb][ApiGroup][Version][Kind]` (camelCased).

### Example: Listing Notes

**GraphQL Operation (`queries/notes.graphql`):**

```graphql
query ListNotes($fieldSelector: String) {
  # Operation name derived from: list + CrmMiloapisCom + V1alpha1 + Note
  listCrmMiloapisComV1alpha1Note(fieldSelector: $fieldSelector) {
    items {
      metadata {
        name
        creationTimestamp
      }
      spec {
        content
        followUp
        subjectRef {
          kind
          name
        }
      }
      status {
        createdBy
      }
    }
  }
}
```

**Client Code (TypeScript):**

```typescript
import { graphqlRequest } from './client' // Your request wrapper
import { ListNotesDocument } from '@/resources/graphql/gen/graphql'

/**
 * Fetch notes for a specific subject (e.g., a User).
 * We use 'fieldSelector' to filter the list on the server side.
 */
async function getNotesForUser(userId: string) {
  // Construct the Kubernetes field selector string
  const fieldSelector = `spec.subjectRef.kind=User,spec.subjectRef.name=${userId}`

  return graphqlRequest(ListNotesDocument, { fieldSelector })
}
```

### Example: Creating a Note

**GraphQL Mutation:**

```graphql
mutation CreateNote($input: com_miloapis_crm_v1alpha1_Note_Input!) {
  createCrmMiloapisComV1alpha1Note(input: $input) {
    apiVersion
    kind
    metadata {
      name
      generateName
    }
    spec {
      followUp
      content
      interactionTime
      nextAction
      nextActionTime
      subjectRef {
        apiGroup
        kind
        name
      }
    }
  }
}
```

## 4. Parent Resources (Scoped Queries)

In addition to the global `/graphql` endpoint, the gateway supports **scoped endpoints** for resources that exist under a parent resource (like `Organization` or `Project`).

Using a scoped endpoint automatically restricts operations to the context of that parent.

### Enabled Parent Resources

Based on `config/resources/parent-resources.yaml`, the following parents are supported:

| Kind           | API Group                      | Version    |
| -------------- | ------------------------------ | ---------- |
| `Organization` | `resourcemanager.miloapis.com` | `v1alpha1` |
| `Project`      | `resourcemanager.miloapis.com` | `v1alpha1` |

### Endpoint URL Format

To query within a parent scope, direct your GraphQL client to:

```text
https://<gateway-host>/<apiGroup>/<version>/<kind>s/<name>/graphql
```

### Examples

#### 1. Organization Scope

If you want to perform operations mapped to Organization `my-org`:

- **URL**: `https://graphql.prod.env.datum.net/resourcemanager.miloapis.com/v1alpha1/organizations/my-org/graphql`
- **Behavior**: Resources created or listed will be scoped to `my-org`.

#### 2. Project Scope

If you want to perform operations mapped to Project `proj-123`:

- **URL**: `https://graphql.prod.env.datum.net/resourcemanager.miloapis.com/v1alpha1/projects/proj-123/graphql`
- **Behavior**: Resources created or listed will be scoped to `proj-123`.

### Client Implementation Note

When switching scopes, you typically re-create or re-configure your GraphQL client instance with the new `uri`.

```typescript
// Example: Creating a client for a specific organization
function createOrgClient(orgName: string) {
  const uri = `https://graphql.prod.env.datum.net/resourcemanager.miloapis.com/v1alpha1/organizations/${orgName}/graphql`

  return new GraphQLClient(uri, {
    /* ... */
  })
}
```
