import { z } from 'zod'

export const CommerceRoleSchema = z.enum(['OPERATOR', 'APPROVER', 'ADMIN', 'EXECUTOR', 'AUDITOR'])
export const CommercePermissionSchema = z.enum([
  'task:create', 'task:read', 'evidence:read', 'report:read',
  'proposal:create', 'proposal:read', 'proposal:approve', 'proposal:reject',
  'proposal:execute', 'audit:read', 'access:manage',
])

export const AuthenticatedPrincipalSchema = z.object({
  actorId: z.string().trim().min(1),
  subject: z.string().trim().min(1),
  tenantId: z.string().trim().min(1),
  roles: z.array(CommerceRoleSchema).min(1),
  permissions: z.array(CommercePermissionSchema),
  allowedShopIds: z.array(z.string().trim().min(1)).min(1),
  authSource: z.enum(['oidc-session', 'service-identity', 'local-test']),
  sessionId: z.string().trim().min(1).optional(),
  membershipVersion: z.number().int().positive(),
}).strict()

export type CommerceRole = z.infer<typeof CommerceRoleSchema>
export type CommercePermission = z.infer<typeof CommercePermissionSchema>
export type AuthenticatedPrincipal = z.infer<typeof AuthenticatedPrincipalSchema>

export type MembershipStatus = 'ACTIVE' | 'REVOKED'

export type Membership = {
  subject: string
  actorId: string
  tenantId: string
  roles: CommerceRole[]
  status: MembershipStatus
  version: number
  createdAt: string
  updatedAt: string
}

export type ShopGrant = {
  subject: string
  tenantId: string
  shopId: string
  status: MembershipStatus
  createdAt: string
  updatedAt: string
}
