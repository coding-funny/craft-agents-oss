import { randomUUID } from 'node:crypto'
import type { Database } from 'bun:sqlite'
import { CommerceError } from '../domain/errors.ts'
import type { CommerceDatabase } from '../storage/database.ts'
import { AuthenticatedPrincipalSchema, type AuthenticatedPrincipal, type CommerceRole, type Membership } from './contracts.ts'
import { permissionsForRoles } from './authorization.ts'
import type { ApprovalRecord, Proposal } from '../approvals/repository.ts'
import { APPROVAL_POLICY_VERSION } from '../approvals/policy.ts'

type MembershipRow = {
  subject: string; tenant_id: string; actor_id: string; roles_json: string
  status: Membership['status']; version: number; created_at: string; updated_at: string
}

type FlowRow = {
  state_hash: string; nonce_hash: string; code_verifier: string; tenant_hint: string | null
  expires_at: string; consumed_at: string | null; created_at: string
}

type SessionRow = {
  session_id: string; token_hash: string; csrf_hash: string; subject: string; tenant_id: string
  membership_version: number; expires_at: string; revoked_at: string | null; created_at: string
}

function membershipFromRow(row: MembershipRow): Membership {
  return {
    subject: row.subject,
    tenantId: row.tenant_id,
    actorId: row.actor_id,
    roles: JSON.parse(row.roles_json) as CommerceRole[],
    status: row.status,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class IdentityRepository {
  readonly #db: Database

  constructor(store: CommerceDatabase) {
    this.#db = store.database
  }

  upsertMembership(input: {
    subject: string; actorId: string; tenantId: string; roles: CommerceRole[]
    status?: Membership['status']; now: string
  }): Membership {
    const existing = this.getMembership(input.subject, input.tenantId)
    const version = (existing?.version ?? 0) + 1
    this.#db.query(`INSERT INTO commerce_memberships (
      subject, tenant_id, actor_id, roles_json, status, version, created_at, updated_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
    ON CONFLICT(subject, tenant_id) DO UPDATE SET
      actor_id = excluded.actor_id, roles_json = excluded.roles_json, status = excluded.status,
      version = excluded.version, updated_at = excluded.updated_at`).run(
      input.subject, input.tenantId, input.actorId, JSON.stringify([...new Set(input.roles)].sort()),
      input.status ?? 'ACTIVE', version, input.now,
    )
    return this.getMembership(input.subject, input.tenantId)!
  }

  getMembership(subject: string, tenantId: string): Membership | undefined {
    const row = this.#db.query<MembershipRow, [string, string]>(
      'SELECT * FROM commerce_memberships WHERE subject = ?1 AND tenant_id = ?2',
    ).get(subject, tenantId)
    return row ? membershipFromRow(row) : undefined
  }

  findActiveMembership(subject: string, tenantHint?: string): Membership {
    if (tenantHint) {
      const row = this.#db.query<MembershipRow, [string, string]>(
        "SELECT * FROM commerce_memberships WHERE subject = ?1 AND tenant_id = ?2 AND status = 'ACTIVE'",
      ).get(subject, tenantHint)
      if (!row) throw new CommerceError('SCOPE_DENIED', 'No active tenant membership exists for this subject')
      return membershipFromRow(row)
    }
    const rows = this.#db.query<MembershipRow, [string]>(
      "SELECT * FROM commerce_memberships WHERE subject = ?1 AND status = 'ACTIVE' ORDER BY tenant_id",
    ).all(subject)
    if (rows.length === 0) throw new CommerceError('SCOPE_DENIED', 'No active tenant membership exists for this subject')
    if (rows.length !== 1) throw new CommerceError('SCOPE_DENIED', 'Tenant selection is required for a multi-tenant subject')
    return membershipFromRow(rows[0]!)
  }

  setShopGrant(input: {
    subject: string; tenantId: string; shopId: string; status?: 'ACTIVE' | 'REVOKED'; now: string
  }): void {
    this.#db.query(`INSERT INTO commerce_shop_grants (
      subject, tenant_id, shop_id, status, created_at, updated_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?5)
    ON CONFLICT(subject, tenant_id, shop_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`).run(
      input.subject, input.tenantId, input.shopId, input.status ?? 'ACTIVE', input.now,
    )
  }

  activeShopIds(subject: string, tenantId: string): string[] {
    return this.#db.query<{ shop_id: string }, [string, string]>(
      "SELECT shop_id FROM commerce_shop_grants WHERE subject = ?1 AND tenant_id = ?2 AND status = 'ACTIVE' ORDER BY shop_id",
    ).all(subject, tenantId).map(row => row.shop_id)
  }

  createFlow(input: {
    stateHash: string; nonceHash: string; codeVerifier: string; tenantHint?: string
    expiresAt: string; now: string
  }): void {
    this.#db.query(`INSERT INTO commerce_oidc_flows (
      state_hash, nonce_hash, code_verifier, tenant_hint, expires_at, created_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`).run(
      input.stateHash, input.nonceHash, input.codeVerifier, input.tenantHint ?? null, input.expiresAt, input.now,
    )
  }

  consumeFlow(stateHash: string, now: string): FlowRow {
    return this.#db.transaction(() => {
      const flow = this.#db.query<FlowRow, [string]>('SELECT * FROM commerce_oidc_flows WHERE state_hash = ?1').get(stateHash)
      if (!flow || flow.consumed_at || Date.parse(flow.expires_at) <= Date.parse(now)) {
        throw new CommerceError('SCOPE_DENIED', 'OIDC state is invalid, expired, or already consumed')
      }
      const changed = this.#db.query(
        'UPDATE commerce_oidc_flows SET consumed_at = ?1 WHERE state_hash = ?2 AND consumed_at IS NULL',
      ).run(now, stateHash)
      if (changed.changes !== 1) throw new CommerceError('SCOPE_DENIED', 'OIDC state replay was rejected')
      return flow
    }).immediate()
  }

  createSession(input: {
    tokenHash: string; csrfHash: string; subject: string; tenantId: string
    membershipVersion: number; expiresAt: string; now: string
  }): string {
    const sessionId = `session_${randomUUID()}`
    this.#db.query(`INSERT INTO commerce_sessions (
      session_id, token_hash, csrf_hash, subject, tenant_id, membership_version, expires_at, created_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`).run(
      sessionId, input.tokenHash, input.csrfHash, input.subject, input.tenantId,
      input.membershipVersion, input.expiresAt, input.now,
    )
    return sessionId
  }

  resolveSession(tokenHash: string, now: string): { principal: AuthenticatedPrincipal; csrfHash: string } {
    const row = this.#db.query<SessionRow, [string]>(
      'SELECT * FROM commerce_sessions WHERE token_hash = ?1',
    ).get(tokenHash)
    if (!row || row.revoked_at || Date.parse(row.expires_at) <= Date.parse(now)) {
      throw new CommerceError('SCOPE_DENIED', 'Session is invalid or expired')
    }
    const membership = this.getMembership(row.subject, row.tenant_id)
    if (!membership || membership.status !== 'ACTIVE' || membership.version !== row.membership_version) {
      throw new CommerceError('SCOPE_DENIED', 'Session authorization is stale or revoked')
    }
    const allowedShopIds = this.activeShopIds(membership.subject, membership.tenantId)
    if (allowedShopIds.length === 0) throw new CommerceError('SCOPE_DENIED', 'No active shop grant exists')
    return {
      csrfHash: row.csrf_hash,
      principal: AuthenticatedPrincipalSchema.parse({
        actorId: membership.actorId,
        subject: membership.subject,
        tenantId: membership.tenantId,
        roles: membership.roles,
        permissions: permissionsForRoles(membership.roles),
        allowedShopIds,
        authSource: 'oidc-session',
        sessionId: row.session_id,
        membershipVersion: membership.version,
      }),
    }
  }

  revokeSession(tokenHash: string, now: string): void {
    this.#db.query('UPDATE commerce_sessions SET revoked_at = ?1 WHERE token_hash = ?2 AND revoked_at IS NULL').run(now, tokenHash)
  }

  assertApprovalStillAuthorized(proposal: Proposal, approval: ApprovalRecord | undefined): void {
    if (!approval || approval.policyVersion !== APPROVAL_POLICY_VERSION || proposal.policyVersion !== APPROVAL_POLICY_VERSION) {
      throw new CommerceError('SCOPE_DENIED', 'Approval policy binding is stale')
    }
    const membership = this.getMembership(approval.subject, proposal.tenantId)
    if (!membership || membership.status !== 'ACTIVE' || membership.actorId !== approval.actor
      || !permissionsForRoles(membership.roles).includes('proposal:approve')
      || !this.activeShopIds(approval.subject, proposal.tenantId).includes(proposal.shopId)) {
      throw new CommerceError('SCOPE_DENIED', 'Approver authorization was revoked before execution')
    }
  }

  audit(input: {
    traceId: string; action: string; decision: 'ALLOW' | 'DENY'; reasonCode: string; createdAt: string
    principal?: Partial<AuthenticatedPrincipal>; shopId?: string
  }): void {
    this.#db.query(`INSERT INTO commerce_authz_audit (
      trace_id, actor_id, subject, tenant_id, shop_id, action, decision, reason_code, created_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`).run(
      input.traceId, input.principal?.actorId ?? null, input.principal?.subject ?? null,
      input.principal?.tenantId ?? null, input.shopId ?? null, input.action,
      input.decision, input.reasonCode, input.createdAt,
    )
  }
}
