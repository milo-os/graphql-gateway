import { utilitiesResolvers } from './utilities'
import { sessionsResolvers } from './sessions'
import { usersResolvers } from './users'
import { contactsResolvers } from './contacts'
import { organizationsResolvers } from './organizations'
import { quotaResolvers } from './quota'

export const additionalResolvers = {
  Query: {
    ...utilitiesResolvers.Query,
    ...sessionsResolvers.Query,
    ...usersResolvers.Query,
    ...contactsResolvers.Query,
    ...organizationsResolvers.Query,
    ...quotaResolvers.Query,
  },
  Mutation: {
    ...sessionsResolvers.Mutation,
    ...usersResolvers.Mutation,
  },
}
