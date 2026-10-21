import { describe, expect, it } from 'vitest'
import { parse } from 'graphql'
import { register } from 'prom-client'
import { isLocallyExecutable } from './plugin'

describe('isLocallyExecutable', () => {
  it('matches a query made entirely of local fields', () => {
    const doc = parse(/* GraphQL */ `
      query {
        parseUserAgent(userAgent: "x") {
          formatted
        }
        geolocateIP(ip: "1.2.3.4") {
          formatted
        }
      }
    `)
    expect(isLocallyExecutable(doc)).toBe(true)
  })

  it('matches a mutation made entirely of local fields', () => {
    const doc = parse(/* GraphQL */ `
      mutation {
        deleteSession(id: "sess-1")
      }
    `)
    expect(isLocallyExecutable(doc)).toBe(true)
  })

  it('matches a pure-introspection schema query (codegen)', () => {
    const doc = parse(/* GraphQL */ `
      query IntrospectionQuery {
        __schema {
          queryType {
            name
          }
          mutationType {
            name
          }
          types {
            name
          }
        }
      }
    `)
    expect(isLocallyExecutable(doc, 'IntrospectionQuery')).toBe(true)
  })

  it('matches a __type introspection query', () => {
    const doc = parse(/* GraphQL */ `
      query {
        __type(name: "ExtendedSession") {
          name
          fields {
            name
          }
        }
      }
    `)
    expect(isLocallyExecutable(doc)).toBe(true)
  })

  it('matches an operation that mixes local fields and introspection meta-fields', () => {
    const doc = parse(/* GraphQL */ `
      query {
        __typename
        sessions {
          id
        }
      }
    `)
    expect(isLocallyExecutable(doc)).toBe(true)
  })

  it('rejects an operation that mixes local and federated fields', () => {
    const doc = parse(/* GraphQL */ `
      query {
        sessions {
          id
        }
        listResourcemanagerMiloapisComV1alpha1OrganizationMembershipForAllNamespaces {
          metadata {
            continue
          }
        }
      }
    `)
    expect(isLocallyExecutable(doc)).toBe(false)
  })

  it('rejects a federated-only query', () => {
    const doc = parse(/* GraphQL */ `
      query {
        listResourcemanagerMiloapisComV1alpha1OrganizationMembershipForAllNamespaces {
          metadata {
            continue
          }
        }
      }
    `)
    expect(isLocallyExecutable(doc)).toBe(false)
  })

  it('rejects subscriptions', () => {
    const doc = parse(/* GraphQL */ `
      subscription {
        sessions {
          id
        }
      }
    `)
    expect(isLocallyExecutable(doc)).toBe(false)
  })

  it('rejects an operation with no top-level fields (e.g. only fragment spreads)', () => {
    const doc = parse(/* GraphQL */ `
      fragment Foo on Query {
        sessions {
          id
        }
      }
      query {
        ...Foo
      }
    `)
    expect(isLocallyExecutable(doc)).toBe(false)
  })

  it('matches the named operation when multiple operations are in the document', () => {
    const doc = parse(/* GraphQL */ `
      query Local {
        sessions {
          id
        }
      }
      query Federated {
        listResourcemanagerMiloapisComV1alpha1OrganizationMembershipForAllNamespaces {
          metadata {
            continue
          }
        }
      }
    `)
    expect(isLocallyExecutable(doc, 'Local')).toBe(true)
    expect(isLocallyExecutable(doc, 'Federated')).toBe(false)
  })
})

describe('graphql_gateway_mixed_operations_total', () => {
  const mixedCount = async (operationName: string) => {
    const metric = await register.getSingleMetric('graphql_gateway_mixed_operations_total')!.get()
    return metric.values.find((v) => v.labels.operationName === operationName)?.value ?? 0
  }

  it('counts a mixed operation by its operation name', async () => {
    const doc = parse(/* GraphQL */ `
      query MixedOperation {
        sessions {
          id
        }
        listResourcemanagerMiloapisComV1alpha1OrganizationMembershipForAllNamespaces {
          metadata {
            continue
          }
        }
      }
    `)
    const before = await mixedCount('MixedOperation')

    expect(isLocallyExecutable(doc, 'MixedOperation')).toBe(false)
    expect(await mixedCount('MixedOperation')).toBe(before + 1)
  })

  it('does not count purely local or purely federated operations', async () => {
    const local = parse(/* GraphQL */ `
      query PureLocal {
        sessions {
          id
        }
      }
    `)
    const federated = parse(/* GraphQL */ `
      query PureFederated {
        listResourcemanagerMiloapisComV1alpha1OrganizationMembershipForAllNamespaces {
          metadata {
            continue
          }
        }
      }
    `)
    const beforeLocal = await mixedCount('PureLocal')
    const beforeFederated = await mixedCount('PureFederated')

    expect(isLocallyExecutable(local, 'PureLocal')).toBe(true)
    expect(isLocallyExecutable(federated, 'PureFederated')).toBe(false)
    expect(await mixedCount('PureLocal')).toBe(beforeLocal)
    expect(await mixedCount('PureFederated')).toBe(beforeFederated)
  })
})
