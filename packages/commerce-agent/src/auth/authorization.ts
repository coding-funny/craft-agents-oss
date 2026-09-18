import { CommerceError } from '../domain/errors.ts'
import type { PrincipalContext } from '../contracts/task.ts'
import type { AuthenticatedPrincipal, CommercePermission, CommerceRole } from './contracts.ts'

const ROLE_PERMISSIONS: Record<CommerceRole, readonly CommercePermission[]> = {
  OPERATOR: ['task:create', 'task:read', 'evidence:read', 'report:read', 'proposal:create', 'proposal:read'],
  APPROVER: ['task:read', 'evidence:read', 'report:read', 'proposal:read', 'proposal:approve', 'proposal:reject', 'audit:read'],
  ADMIN: ['task:read', 'evidence:read', 'report:read', 'proposal:read', 'audit:read', 'access:manage'],
  EXECUTOR: ['proposal:read', 'proposal:execute', 'audit:read'],
  AUDITOR: ['task:read', 'evidence:read', 'report:read', 'proposal:read', 'audit:read'],
}

export function permissionsForRoles(roles: CommerceRole[]): CommercePermission[] {
  return [...new Set(roles.flatMap(role => ROLE_PERMISSIONS[role]))].sort()
}

export function requirePermission(principal: AuthenticatedPrincipal, permission: CommercePermission): void {
  if (!principal.permissions.includes(permission)) {
    throw new CommerceError('SCOPE_DENIED', `Permission denied: ${permission}`)
  }
}

export function requireShopAccess(principal: AuthenticatedPrincipal, shopId: string): void {
  if (!principal.allowedShopIds.includes(shopId)) {
    throw new CommerceError('SCOPE_DENIED', 'Resource is outside principal scope')
  }
}

export function toInvestigationPrincipal(principal: AuthenticatedPrincipal): PrincipalContext {
  requirePermission(principal, 'task:create')
  return {
    actorId: principal.actorId,
    tenantId: principal.tenantId,
    allowedShopIds: principal.allowedShopIds,
    permissions: [
      'investigate',
      ...(principal.permissions.includes('evidence:read') ? ['read_evidence' as const] : []),
      ...(principal.permissions.includes('report:read') ? ['read_report' as const] : []),
    ],
    authSource: principal.authSource,
  }
}
