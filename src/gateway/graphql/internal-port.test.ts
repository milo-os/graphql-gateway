import { parse } from 'graphql'
import type { ExecutionResult } from 'graphql'
import { describe, expect, it } from 'vitest'
import {
  markInternalRequest,
  servesOnInternalPort,
  useInternalPortAllowlist,
} from './internal-port'

const serves = (query: string, operationName?: string) =>
  servesOnInternalPort(parse(query), operationName)

describe('servesOnInternalPort', () => {
  it.each([
    ['parseUserAgent', '{ parseUserAgent(userAgent: "curl/8") { formatted } }'],
    ['geolocateIP', '{ geolocateIP(ip: "1.1.1.1") { city } }'],
    [
      'both fields',
      '{ parseUserAgent(userAgent: "curl/8") { formatted } geolocateIP(ip: "1.1.1.1") { city } }',
    ],
    ['an inline fragment', '{ ... on Query { geolocateIP(ip: "1.1.1.1") { city } } }'],
    [
      'a named fragment',
      'query { ...F } fragment F on Query { parseUserAgent(userAgent: "curl/8") { formatted } }',
    ],
  ])('serves %s', (_name, query) => {
    expect(serves(query)).toBe(true)
  })

  it.each([
    [
      'a federated field',
      '{ listResourcemanagerMiloapisComV1alpha1OrganizationMembershipForAllNamespaces { __typename } }',
    ],
    ['introspection', '{ __schema { queryType { name } } }'],
    ['__type', '{ __type(name: "Query") { name } }'],
    ['__typename', '{ __typename }'],
    [
      'a local field mixed with a federated one',
      '{ geolocateIP(ip: "1.1.1.1") { city } readCoreV1Namespace(name: "x") { __typename } }',
    ],
    [
      'a local field mixed with introspection',
      '{ parseUserAgent(userAgent: "curl/8") { formatted } __schema { types { name } } }',
    ],
    ['another gateway-local field', '{ users(limit: 1) { __typename } }'],
    ['a mutation', 'mutation { deleteSession(sessionID: "s") }'],
    ['a subscription', 'subscription { geolocateIP(ip: "1.1.1.1") { city } }'],
    [
      'a federated field hidden in a named fragment',
      'query { ...F } fragment F on Query { geolocateIP(ip: "1") { city } __schema { types { name } } }',
    ],
    ['a spread of an undefined fragment', 'query { ...Missing }'],
    ['a fragment that spreads itself', 'query { ...F } fragment F on Query { ...F }'],
    ['an empty selection', 'query { ... on Query { ... on Query { __typename } } }'],
  ])('refuses %s', (_name, query) => {
    expect(serves(query)).toBe(false)
  })

  it('checks the named operation in a document with several', () => {
    const query = `
      query Local { geolocateIP(ip: "1.1.1.1") { city } }
      query Remote { readCoreV1Namespace(name: "x") { __typename } }
    `
    expect(serves(query, 'Local')).toBe(true)
    expect(serves(query, 'Remote')).toBe(false)
    expect(serves(query, 'Missing')).toBe(false)
  })

  it('refuses an unnamed choice between several operations', () => {
    expect(serves('query A { geolocateIP(ip: "1") { city } } query B { __typename }')).toBe(false)
  })
})

describe('useInternalPortAllowlist', () => {
  const run = (req: object, query: string) => {
    let stopped: ExecutionResult | undefined
    useInternalPortAllowlist().onExecute!({
      args: { contextValue: { req }, document: parse(query), operationName: undefined },
      setResultAndStopExecution: (result: ExecutionResult) => (stopped = result),
    } as never)
    return stopped
  }

  it('refuses a federated query on the internal port with 403 FORBIDDEN', () => {
    const req = {}
    markInternalRequest(req)

    const stopped = run(req, '{ readCoreV1Namespace(name: "x") { __typename } }')

    expect(stopped?.errors?.[0].extensions).toEqual({ code: 'FORBIDDEN', http: { status: 403 } })
  })

  it('refuses introspection on the internal port', () => {
    const req = {}
    markInternalRequest(req)
    expect(run(req, '{ __schema { queryType { name } } }')?.errors).toHaveLength(1)
  })

  it('lets the local fields through on the internal port', () => {
    const req = {}
    markInternalRequest(req)
    expect(run(req, '{ parseUserAgent(userAgent: "curl/8") { formatted } }')).toBeUndefined()
  })

  it('leaves requests from the routed port alone', () => {
    expect(run({}, '{ readCoreV1Namespace(name: "x") { __typename } }')).toBeUndefined()
  })

  it('refuses every subscription on the internal port', () => {
    const req = {}
    markInternalRequest(req)
    let stopped: ExecutionResult | undefined
    useInternalPortAllowlist().onSubscribe!({
      args: { contextValue: { req }, document: parse('subscription { a }') },
      setResultAndStopExecution: (result: ExecutionResult) => (stopped = result),
    } as never)
    expect(stopped?.errors?.[0].extensions?.code).toBe('FORBIDDEN')
  })
})
