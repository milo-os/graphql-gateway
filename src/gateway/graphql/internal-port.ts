import { GraphQLError, Kind } from 'graphql'
import type {
  DocumentNode,
  FragmentDefinitionNode,
  OperationDefinitionNode,
  SelectionSetNode,
} from 'graphql'
import type { Plugin } from 'graphql-yoga'

/**
 * The only root fields the internal port serves. Both are answered by the
 * gateway itself, without calling Milo, which is all the Zitadel actions
 * receiver needs.
 *
 * Nothing else may run there: the internal port skips the token check, and a
 * federated field would reach Milo with whatever identity the gateway's fetch
 * carries. Today Hive's transport sends no client certificate, but initAuth
 * overrides the global fetch to present one, so that rests on which fetch Hive
 * picks rather than on anything this repo controls.
 */
export const INTERNAL_PORT_FIELDS: ReadonlySet<string> = new Set(['geolocateIP', 'parseUserAgent'])

const internalRequests = new WeakSet<object>()

/** Marks a request as having arrived on the internal port. */
export const markInternalRequest = (req: object): void => {
  internalRequests.add(req)
}

/** True when markInternalRequest saw this request. */
export const receivedOnInternalPort = (req: unknown): boolean =>
  typeof req === 'object' && req !== null && internalRequests.has(req)

/** Yoga's context carries the Node request it was handed as `req`. */
const isInternalRequest = (context: unknown): boolean =>
  receivedOnInternalPort((context as { req?: unknown } | null)?.req)

const selectOperation = (
  doc: DocumentNode,
  operationName?: string | null
): OperationDefinitionNode | undefined => {
  const operations = doc.definitions.filter(
    (d): d is OperationDefinitionNode => d.kind === Kind.OPERATION_DEFINITION
  )
  if (operationName) return operations.find((op) => op.name?.value === operationName)
  return operations.length === 1 ? operations[0] : undefined
}

/**
 * Root field names of a selection set, with fragment spreads and inline
 * fragments expanded. Returns null when a spread names a fragment the
 * document does not define, or a fragment spreads itself.
 */
const rootFieldNames = (
  selectionSet: SelectionSetNode,
  fragments: ReadonlyMap<string, FragmentDefinitionNode>,
  visiting: ReadonlySet<string> = new Set()
): string[] | null =>
  selectionSet.selections.reduce<string[] | null>((names, selection) => {
    if (names === null) return null
    if (selection.kind === Kind.FIELD) return [...names, selection.name.value]
    if (selection.kind === Kind.INLINE_FRAGMENT) {
      const inner = rootFieldNames(selection.selectionSet, fragments, visiting)
      return inner && [...names, ...inner]
    }
    const name = selection.name.value
    const fragment = fragments.get(name)
    if (!fragment || visiting.has(name)) return null
    const inner = rootFieldNames(fragment.selectionSet, fragments, new Set([...visiting, name]))
    return inner && [...names, ...inner]
  }, [])

/**
 * True when the operation is a query whose root fields are all in
 * INTERNAL_PORT_FIELDS. Introspection, federated fields, other gateway-local
 * fields, mutations and subscriptions are all refused.
 */
export const servesOnInternalPort = (doc: DocumentNode, operationName?: string | null): boolean => {
  const op = selectOperation(doc, operationName)
  if (op?.operation !== 'query') return false
  const fragments = new Map(
    doc.definitions
      .filter((d): d is FragmentDefinitionNode => d.kind === Kind.FRAGMENT_DEFINITION)
      .map((d) => [d.name.value, d] as const)
  )
  const names = rootFieldNames(op.selectionSet, fragments)
  return names !== null && names.length > 0 && names.every((n) => INTERNAL_PORT_FIELDS.has(n))
}

const refusal = () =>
  new GraphQLError(
    `Only ${[...INTERNAL_PORT_FIELDS].join(' and ')} are served on the internal port`,
    { extensions: { code: 'FORBIDDEN', http: { status: 403 } } }
  )

/**
 * Refuses, before Hive executes it, any operation on the internal port that
 * asks for more than INTERNAL_PORT_FIELDS. Requests on the routed port are
 * left alone; they have already passed the token check.
 */
export const useInternalPortAllowlist = (): Plugin => ({
  onExecute({ args, setResultAndStopExecution }) {
    if (!isInternalRequest(args.contextValue)) return
    if (servesOnInternalPort(args.document, args.operationName)) return
    setResultAndStopExecution({ errors: [refusal()] })
  },
  onSubscribe({ args, setResultAndStopExecution }) {
    if (!isInternalRequest(args.contextValue)) return
    setResultAndStopExecution({ errors: [refusal()] })
  },
})
