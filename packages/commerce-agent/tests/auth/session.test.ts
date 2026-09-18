import { describe, expect, it } from 'bun:test'
import { CommerceDatabase } from '../../src/storage/database.ts'
import { IdentityRepository } from '../../src/auth/repository.ts'
import { permissionsForRoles } from '../../src/auth/authorization.ts'
import { assertCsrf, secretHash } from '../../src/auth/session.ts'

const NOW = '2026-09-18T08:00:00.000Z'

function seeded() {
  const store = new CommerceDatabase(':memory:')
  const identity = new IdentityRepository(store)
  const membership = identity.upsertMembership({
    subject: 'oidc|operator-1', actorId: 'operator-1', tenantId: 'tenant-a', roles: ['OPERATOR'], now: NOW,
  })
  identity.setShopGrant({ subject: membership.subject, tenantId: membership.tenantId, shopId: 'shop-a', now: NOW })
  identity.createSession({
    tokenHash: secretHash('raw-session-token'), csrfHash: secretHash('raw-csrf-token'),
    subject: membership.subject, tenantId: membership.tenantId, membershipVersion: membership.version,
    expiresAt: '2026-09-18T10:00:00.000Z', now: NOW,
  })
  return { store, identity, membership }
}

describe('identity sessions and authorization refresh', () => {
  it('keeps operator, approver, admin, executor, and auditor permissions least-privileged', () => {
    expect(permissionsForRoles(['OPERATOR'])).toContain('proposal:create')
    expect(permissionsForRoles(['OPERATOR'])).not.toContain('proposal:approve')
    expect(permissionsForRoles(['APPROVER'])).toContain('proposal:approve')
    expect(permissionsForRoles(['ADMIN'])).not.toContain('proposal:approve')
    expect(permissionsForRoles(['EXECUTOR'])).toEqual(['audit:read', 'proposal:execute', 'proposal:read'])
    expect(permissionsForRoles(['AUDITOR'])).not.toContain('proposal:execute')
  })

  it('derives permissions from server-side roles and stores only session hashes', () => {
    const { store, identity } = seeded()
    const resolved = identity.resolveSession(secretHash('raw-session-token'), NOW)
    expect(resolved.principal.permissions).toEqual(permissionsForRoles(['OPERATOR']))
    expect(resolved.principal.allowedShopIds).toEqual(['shop-a'])
    const persisted = store.database.query<{ token_hash: string; csrf_hash: string }, []>(
      'SELECT token_hash, csrf_hash FROM commerce_sessions',
    ).get()!
    expect(JSON.stringify(persisted)).not.toContain('raw-session-token')
    expect(JSON.stringify(persisted)).not.toContain('raw-csrf-token')
  })

  it('invalidates a live session when membership or shop authorization changes', () => {
    const { identity, membership } = seeded()
    identity.upsertMembership({ ...membership, roles: ['OPERATOR'], status: 'REVOKED', now: '2026-09-18T08:01:00.000Z' })
    expect(() => identity.resolveSession(secretHash('raw-session-token'), NOW)).toThrow('stale or revoked')
  })

  it('requires an explicit tenant when one subject has multiple active memberships', () => {
    const { identity, membership } = seeded()
    identity.upsertMembership({
      subject: membership.subject, actorId: membership.actorId, tenantId: 'tenant-b', roles: ['OPERATOR'], now: NOW,
    })
    expect(() => identity.findActiveMembership(membership.subject)).toThrow('Tenant selection')
    expect(identity.findActiveMembership(membership.subject, 'tenant-b').tenantId).toBe('tenant-b')
  })

  it('requires both an allowlisted origin and matching CSRF secret for writes', () => {
    const valid = new Request('https://api.example.test/api/v1/tasks', {
      method: 'POST', headers: { origin: 'https://ops.example.test', 'x-csrf-token': 'raw-csrf-token' },
    })
    expect(() => assertCsrf(valid, secretHash('raw-csrf-token'), ['https://ops.example.test'])).not.toThrow()
    const hostile = new Request(valid, { headers: { origin: 'https://evil.test', 'x-csrf-token': 'raw-csrf-token' } })
    expect(() => assertCsrf(hostile, secretHash('raw-csrf-token'), ['https://ops.example.test'])).toThrow('Origin')
  })
})
