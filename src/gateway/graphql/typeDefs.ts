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
    "Human-readable name from the kubernetes.io/display-name annotation, falling back to kubernetes.io/description, then name."
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

  # --- Contact membership enrichment ---

  type ContactRef {
    name: String!
    namespace: String!
  }

  type EnrichedContact {
    name: String!
    namespace: String!
    email: String
    givenName: String
    familyName: String
    displayName: String
  }

  type EnrichedContactGroup {
    name: String!
    namespace: String!
    displayName: String
  }

  type ContactGroupMembershipEnriched {
    "metadata.name of the ContactGroupMembership resource."
    name: String!
    contactRef: ContactRef!
    "Full Contact data, null if lookup failed."
    contact: EnrichedContact
  }

  type ContactMembershipEnriched {
    "metadata.name of the ContactGroupMembership resource."
    name: String!
    contactGroupRef: ContactRef!
    "Full ContactGroup data, null if lookup failed."
    contactGroup: EnrichedContactGroup
  }

  type EnrichedContactGroupMembershipList {
    items: [ContactGroupMembershipEnriched!]!
    "Kubernetes continue token for pagination."
    continue: String
  }

  type EnrichedContactMembershipList {
    items: [ContactMembershipEnriched!]!
    continue: String
  }

  # --- User batch lookup ---

  type UserSummary {
    "metadata.name of the User resource."
    name: String!
    email: String
    givenName: String
    familyName: String
  }

  type User {
    "metadata.name — the stable user ID."
    name: String!
    uid: String
    resourceVersion: String
    email: String
    givenName: String
    familyName: String
    createdAt: String
    "preferences/theme annotation."
    theme: String
    "preferences/timezone annotation."
    timezone: String
    "preferences/newsletter annotation parsed to boolean."
    newsletter: Boolean
    "onboarding/completedAt annotation."
    onboardedAt: String
    registrationApproval: String
    state: String
    avatarUrl: String
    lastLoginProvider: String
    nameReviewRequired: Boolean
  }

  type UserIdentity {
    name: String!
    createdAt: String
    userUID: String
    providerID: String
    providerName: String
    username: String
  }

  input UpdateUserInput {
    givenName: String
    familyName: String
    email: String
  }

  input UpdateUserPreferencesInput {
    theme: String
    timezone: String
    newsletter: Boolean
    onboardedAt: String
  }

  type OrgContactInfo {
    "Legal / company name from spec.contactInfo.businessName."
    businessName: String
    "Primary contact name from spec.contactInfo.name."
    name: String
    "Primary contact email from spec.contactInfo.email."
    email: String
  }

  type Organization {
    "metadata.name — the stable organization ID."
    name: String!
    "Human-readable name from the kubernetes.io/display-name annotation, falling back to name."
    displayName: String!
    "Organization type: Personal or Standard."
    type: String!
    createdAt: String
    "Status of the Ready condition."
    state: String
    "Contact details from spec.contactInfo."
    contactInfo: OrgContactInfo
    "True when the OnboardingComplete condition status is True."
    onboardingComplete: Boolean!
    "Reason from the OnboardingComplete condition."
    onboardingReason: String
    "Human-readable message from the OnboardingComplete condition."
    onboardingMessage: String
    "Members and pending invitations for this organization."
    members: [OrgMember!]!
    "Projects owned by this organization (via its control plane)."
    projects(limit: Int, cursor: String): ProjectList!
  }

  type OrganizationList {
    items: [Organization!]!
    "Pagination cursor — pass as cursor on the next call to continue listing."
    continueToken: String
  }

  type Project {
    "metadata.name — the stable project ID."
    name: String!
    "Human-readable name from the kubernetes.io/display-name annotation, falling back to kubernetes.io/description, then name."
    displayName: String!
    "Name of the owning organization."
    organizationName: String!
    "Owning organization's display name (kubernetes.io/display-name), falling back to organizationName."
    organizationDisplayName: String!
    "Owning organization's company / legal name from contactInfo.businessName."
    organizationBusinessName: String
    "True when the project has an Active billing-account binding to an account with a default payment method."
    hasActiveBillingAccount: Boolean!
    "Bound billing account name when hasActiveBillingAccount is true."
    billingAccountName: String
    createdAt: String
    "Status of the Ready condition."
    state: String
  }

  type ProjectList {
    items: [Project!]!
    "Pagination cursor — pass as cursor on the next call to continue listing."
    continueToken: String
  }

  type OrgMember {
    "Resource name of the membership or invitation."
    name: String!
    givenName: String
    familyName: String
    email: String!
    roles: [String!]!
    "member or invitation"
    type: String!
    "Only set for invitations: Pending, Accepted, Declined."
    invitationState: String
    createdAt: String
    "The member's user resource name. Null for invitations, which have no user yet."
    userName: String
    "Avatar URL from the membership user status. Null for invitations."
    avatarUrl: String
  }

  type QuotaBucket {
    "metadata.name"
    name: String!
    "metadata.namespace (needed for grant creation)"
    namespace: String!
    "spec.resourceType"
    resourceType: String!
    "spec.consumerRef.kind — Organization or Project"
    consumerKind: String!
    "spec.consumerRef.name"
    consumerName: String!
    "spec.consumerRef.apiGroup"
    consumerApiGroup: String!
    "status.allocated"
    allocated: Int!
    "status.limit"
    limit: Int!
    "status.available"
    available: Int!
    "Display name: kubernetes.io/display-name annotation → hardcoded map → raw resourceType"
    displayName: String!
    "kubernetes.io/description annotation or spec.description from the ResourceRegistration"
    description: String
    "spec.type from the ResourceRegistration: Entity, Allocation, or Feature"
    registrationType: String
    "Owning service canonical name from labels (services.miloapis.com/owner or /service)"
    serviceOwner: String
    "Resolved human-readable service group name"
    serviceDisplayName: String!
  }

  type QuotaBucketList {
    items: [QuotaBucket!]!
  }

  type QuotaGrantAllowance {
    "resourceType for this allowance"
    resourceType: String!
    "Resolved display name (same logic as QuotaBucket.displayName)"
    displayName: String!
    "Resolved service group name"
    serviceDisplayName: String!
    "Sum of all bucket amounts for this resourceType within the grant"
    amount: Int!
  }

  type QuotaCondition {
    type: String!
    status: String!
    message: String
  }

  type QuotaGrant {
    "metadata.name"
    name: String!
    "metadata.namespace"
    namespace: String!
    "metadata.creationTimestamp"
    createdAt: String
    "Whether this grant was auto-created (quota.miloapis.com/auto-created label)"
    autoCreated: Boolean!
    "Flattened and enriched allowances (one entry per resourceType)"
    allowances: [QuotaGrantAllowance!]!
    "status.conditions for status badge display"
    conditions: [QuotaCondition!]!
  }

  type QuotaGrantList {
    items: [QuotaGrant!]!
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
    """
    Lists ContactGroupMemberships across all namespaces, enriched with full
    Contact data for each membership. Resolves all contacts in parallel.
    fieldSelector supports standard Kubernetes field selectors.
    """
    contactGroupMembershipsWithContacts(
      namespace: String
      fieldSelector: String
      limit: Int
      cursor: String
    ): EnrichedContactGroupMembershipList!
    """
    Lists ContactGroupMemberships in the given namespace, enriched with full
    ContactGroup data for each membership. Resolves all contact groups in parallel.
    """
    contactMembershipsWithGroups(
      namespace: String
      fieldSelector: String
      limit: Int
      cursor: String
    ): EnrichedContactMembershipList!
    """
    Batch-fetches User summaries by name. Fetches run in parallel; individual
    lookup failures return null for that entry (filtered from the result).
    """
    userSummaries(names: [String!]!): [UserSummary!]!
    "Returns the full User resource for the authenticated caller (id='me') or by explicit ID."
    me: User
    user(id: String!): User
    "Lists UserIdentity resources scoped to the given user."
    userIdentities(userID: String!): [UserIdentity!]!
    """
    Lists all organizations the caller can access. When \`search\` is set, matches
    substring against name, displayName, company, and contact fields (walks
    upstream pages until \`limit\` matches).
    """
    organizations(limit: Int, cursor: String, search: String): OrganizationList!
    "Returns a single organization by name."
    organization(name: String!): Organization
    "Lists projects in an organization via its control plane."
    organizationProjects(orgName: String!, limit: Int, cursor: String): ProjectList!
    "Lists members and pending invitations for an organization."
    organizationMembers(orgName: String!): [OrgMember!]!
    "Lists all projects the caller can access."
    projects(limit: Int, cursor: String, search: String): ProjectList!
    "Returns a single project by name."
    project(name: String!): Project
    "Enriched quota buckets for an org — joins AllowanceBuckets with ResourceRegistrations server-side."
    orgQuotaBuckets(orgName: String!): QuotaBucketList!
    "Enriched quota buckets for a project — joins AllowanceBuckets with ResourceRegistrations server-side."
    projectQuotaBuckets(projectName: String!): QuotaBucketList!
    "Enriched resource grants for an org with flattened, display-enriched allowances."
    orgQuotaGrants(orgName: String!): QuotaGrantList!
    "Enriched resource grants for a project with flattened, display-enriched allowances."
    projectQuotaGrants(projectName: String!): QuotaGrantList!
  }

  extend type Mutation {
    deleteSession(id: String!): Boolean!
    "Updates a user's profile fields (givenName, familyName, email)."
    updateUser(id: String!, input: UpdateUserInput!): User!
    "Updates a user's preferences stored as annotations."
    updateUserPreferences(id: String!, input: UpdateUserPreferencesInput!): User!
    "Deletes a user account. Returns the deleted user."
    deleteUser(id: String!): User
  }
`
