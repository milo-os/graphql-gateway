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

  extend type Query {
    parseUserAgent(userAgent: String!): ParsedUserAgent!
    geolocateIP(ip: String!): GeoLocation
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
