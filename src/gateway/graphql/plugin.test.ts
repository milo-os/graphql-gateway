import { afterEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'graphql'
import { register } from 'prom-client'
import { log } from '@/shared/utils'
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
  const mixedCount = async () => {
    const metric = await register.getSingleMetric('graphql_gateway_mixed_operations_total')!.get()
    return metric.values[0]?.value ?? 0
  }

  const metricLabels = async () => {
    const metric = await register.getSingleMetric('graphql_gateway_mixed_operations_total')!.get()
    return metric.values.map((value) => Object.keys(value.labels))
  }

  afterEach(() => vi.restoreAllMocks())

  it('counts a mixed operation without labels and logs its operation name', async () => {
    const info = vi.spyOn(log, 'info')
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
    const before = await mixedCount()

    expect(isLocallyExecutable(doc, 'MixedOperation')).toBe(false)
    expect(await mixedCount()).toBe(before + 1)
    expect(await metricLabels()).toEqual([[]])
    expect(info).toHaveBeenCalledWith('Mixed local and federated operation', {
      operationName: 'MixedOperation',
    })
  })

  it('logs anonymous when a mixed operation has no name', async () => {
    const info = vi.spyOn(log, 'info')
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
    const before = await mixedCount()

    expect(isLocallyExecutable(doc)).toBe(false)
    expect(await mixedCount()).toBe(before + 1)
    expect(info).toHaveBeenCalledWith('Mixed local and federated operation', {
      operationName: 'anonymous',
    })
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
    const before = await mixedCount()

    expect(isLocallyExecutable(local, 'PureLocal')).toBe(true)
    expect(isLocallyExecutable(federated, 'PureFederated')).toBe(false)
    expect(await mixedCount()).toBe(before)
  })
})
