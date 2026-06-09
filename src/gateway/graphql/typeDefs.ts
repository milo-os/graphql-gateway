export const additionalTypeDefs = /* GraphQL */ `
  type ParsedUserAgent {
    browser: String
    os: String
    formatted: String!
  }

  type GeoLocation {
    city: String
    country: String
    countryCode: String
    formatted: String!
  }

  type ExtendedSession {
    id: String!
    userUID: String!
    provider: String!
    ipAddress: String
    fingerprintID: String
    createdAt: String!
    lastUpdatedAt: String
    userAgent: ParsedUserAgent
    location: GeoLocation
  }

  type ConsumerProject {
    "The project's machine name (metadata.name)."
    name: String!
    "Human-readable name from the kubernetes.io/description annotation, falling back to name."
    displayName: String!
  }

  type ServiceConsumer {
    "The ServiceConsumer's name (metadata.name)."
    name: String!
    "The referenced service (spec.serviceRef.name), used by callers to filter by service."
    serviceName: String
    "Lifecycle phase (status.phase), e.g. Active, PendingApproval."
    phase: String
    "Approval decision (spec.approval.decision), e.g. Approved, Denied."
    approvalDecision: String
    "Optional approval note (spec.approval.message)."
    approvalMessage: String
    "When the consumer was requested (metadata.creationTimestamp)."
    requestedAt: String
    "The consuming project, enriched with its display name."
    consumerProject: ConsumerProject!
  }

  extend type Query {
    parseUserAgent(userAgent: String!): ParsedUserAgent!
    geolocateIP(ip: String!): GeoLocation
    """
    Lists ServiceConsumers in the given producer project, enriched with each
    consumer project's human-readable display name (the
    kubernetes.io/description annotation on the Project, falling back to the
    project name).

    Authorization uses the caller's bearer token for both the consumer list
    (in the producer project's control plane) and the per-project lookups (at
    the core resourcemanager API). A list failure returns an empty list; a
    per-project lookup failure degrades that row to the raw project name.
    """
    serviceConsumers(producerProject: ID!): [ServiceConsumer!]!
    """
    Returns sessions for the authenticated caller by default.

    When userID is provided and differs from the caller, the request is
    forwarded to milo with a status.userUID field selector. milo authorizes
    the cross-user lookup via SubjectAccessReview against
    iam.miloapis.com/users/<userID> — callers without that permission get
    an empty list (the underlying 403 is logged).
    """
    sessions(userID: ID): [ExtendedSession!]!
  }

  extend type Mutation {
    deleteSession(id: String!): Boolean!
  }
`
