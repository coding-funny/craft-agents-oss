import { AuthenticatedPrincipalSchema, type AuthenticatedPrincipal, type CommerceRole } from './contracts.ts'
import { permissionsForRoles } from './authorization.ts'

export function localTestPrincipal(options: {
  actorId: string; roles: CommerceRole[]; tenantId?: string; shopIds?: string[]
  authSource?: AuthenticatedPrincipal['authSource']; subject?: string
}): AuthenticatedPrincipal {
  return AuthenticatedPrincipalSchema.parse({
    actorId: options.actorId,
    subject: options.subject ?? `local:${options.actorId}`,
    tenantId: options.tenantId ?? 'local-tenant',
    roles: options.roles,
    permissions: permissionsForRoles(options.roles),
    allowedShopIds: options.shopIds ?? ['demo-shop'],
    authSource: options.authSource ?? 'local-test',
    membershipVersion: 1,
  })
}
