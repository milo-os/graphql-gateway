export const additionalTypeDefs = /* GraphQL */ `
  scalar JSON

  type ParsedUserAgent {
    browser: String
    os: String
    formatted: String!
  }

  type ExtendedSession {
    id: String!
    userAgent: ParsedUserAgent
    location: String
    ipAddress: String
    raw: JSON
  }

  extend type Query {
    parseUserAgent(userAgent: String!): ParsedUserAgent!
    sessions: [ExtendedSession!]!
  }
`
