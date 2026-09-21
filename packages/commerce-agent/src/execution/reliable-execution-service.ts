import { randomUUID } from 'node:crypto'
import type { Database } from 'bun:sqlite'
import type { AuthenticatedPrincipal } from '../auth/contracts.ts'
import { requirePermission, requireShopAccess } from '../auth/authorization.ts'
import { assertProposalIntegrity, contentDigest, type ApprovalRecord, type Proposal, type ProposalRepository } from '../approvals/repository.ts'
import { CommerceError } from '../domain/errors.ts'
import type { ActionExecutor, ActionOutcome, ActionRequest, LookupOutcome } from './action-executor.ts'

export type ExecutionRequestStatus = 'PREPARED' | 'SENT' | 'APPLIED' | 'REJECTED' | 'UNKNOWN' | 'MANUAL_REVIEW' | 'CANCELLED'

export type ExecutionRequestRecord = {
  requestId: string; proposalId: string; tenantId: string; shopId: string; idempotencyKey: string
  payloadHash: string; request: ActionRequest; status: ExecutionRequestStatus; externalOperationId?: string
  result?: unknown; lookupAttempts: number; nextLookupAt?: string; uncertaintyDeadline: string
  lastError?: string; createdAt: string; updatedAt: string
}

type RequestRow = {
  request_id: string; proposal_id: string; tenant_id: string; shop_id: string; idempotency_key: string
  payload_hash: string; request_json: string; status: ExecutionRequestStatus; external_operation_id: string | null
  result_json: string | null; lookup_attempts: number; next_lookup_at: string | null
  uncertainty_deadline: string; last_error: string | null; created_at: string; updated_at: string
}

function recordFromRow(row: RequestRow): ExecutionRequestRecord {
  return {
    requestId: row.request_id, proposalId: row.proposal_id, tenantId: row.tenant_id, shopId: row.shop_id,
    idempotencyKey: row.idempotency_key, payloadHash: row.payload_hash,
    request: JSON.parse(row.request_json) as ActionRequest, status: row.status,
    externalOperationId: row.external_operation_id ?? undefined,
    result: row.result_json ? JSON.parse(row.result_json) : undefined,
    lookupAttempts: row.lookup_attempts, nextLookupAt: row.next_lookup_at ?? undefined,
    uncertaintyDeadline: row.uncertainty_deadline, lastError: row.last_error ?? undefined,
    createdAt: row.created_at, updatedAt: row.updated_at,
  }
}

export class ReliableExecutionService {
  readonly #db: Database
  readonly #repository: ProposalRepository
  readonly #executor: ActionExecutor
  readonly #now: () => Date
  readonly #approvalGuard: (proposal: Proposal, approval: ApprovalRecord | undefined) => void
  readonly #uncertaintyTtlMs: number
  readonly #maxLookupAttempts: number

  constructor(options: {
    database: Database; repository: ProposalRepository; executor: ActionExecutor; now?: () => Date
    approvalGuard: (proposal: Proposal, approval: ApprovalRecord | undefined) => void
    uncertaintyTtlMs?: number; maxLookupAttempts?: number
  }) {
    this.#db = options.database
    this.#repository = options.repository
    this.#executor = options.executor
    this.#now = options.now ?? (() => new Date())
    this.#approvalGuard = options.approvalGuard
    this.#uncertaintyTtlMs = options.uncertaintyTtlMs ?? 15 * 60_000
    this.#maxLookupAttempts = options.maxLookupAttempts ?? 8
  }

  getByProposal(proposalId: string): ExecutionRequestRecord | undefined {
    const row = this.#db.query<RequestRow, [string]>(
      'SELECT * FROM commerce_execution_requests WHERE proposal_id = ?1',
    ).get(proposalId)
    return row ? recordFromRow(row) : undefined
  }

  async execute(input: { proposalId: string; principal: AuthenticatedPrincipal; signal?: AbortSignal }): Promise<ExecutionRequestRecord> {
    let proposal = this.#repository.getOrThrow(input.proposalId)
    this.#authorize(input.principal, proposal)
    const existing = this.getByProposal(proposal.proposalId)
    if (existing) {
      if (existing.status === 'PREPARED') return this.#send(existing, input.principal, input.signal)
      if (existing.status === 'SENT' || existing.status === 'UNKNOWN') return this.reconcile(input)
      return existing
    }
    assertProposalIntegrity(proposal)
    if (proposal.status !== 'APPROVED') throw new CommerceError('INVALID_ARGUMENT', `Proposal cannot execute from status: ${proposal.status}`)
    const approval = this.#repository.latestApproval(proposal.proposalId)
    if (!approval || approval.decision !== 'APPROVED' || approval.contentHash !== proposal.contentHash) {
      throw new CommerceError('INVALID_ARGUMENT', 'Proposal does not have a valid approval for its current content')
    }
    this.#approvalGuard(proposal, approval)
    const now = this.#now().toISOString()
    if (Date.parse(proposal.expiresAt) <= Date.parse(now)) {
      this.#repository.transaction(() => this.#repository.transition(proposal.proposalId, 'APPROVED', 'EXPIRED'))
      throw new CommerceError('INVALID_ARGUMENT', 'Proposal approval has expired')
    }
    const request: ActionRequest = {
      requestId: `request_${randomUUID()}`, idempotencyKey: proposal.idempotencyKey,
      tenantId: proposal.tenantId, shopId: proposal.shopId, proposalId: proposal.proposalId,
      actionType: proposal.actionType, targetId: proposal.targetId, expectedVersion: proposal.targetVersion,
      parameters: proposal.parameters, contentHash: proposal.contentHash,
    }
    const record: ExecutionRequestRecord = {
      requestId: request.requestId, proposalId: proposal.proposalId, tenantId: proposal.tenantId,
      shopId: proposal.shopId, idempotencyKey: proposal.idempotencyKey, payloadHash: contentDigest(request),
      request, status: 'PREPARED', lookupAttempts: 0,
      uncertaintyDeadline: new Date(Date.parse(now) + this.#uncertaintyTtlMs).toISOString(), createdAt: now, updatedAt: now,
    }
    this.#repository.transaction(() => {
      proposal = this.#repository.transition(proposal.proposalId, 'APPROVED', 'EXECUTING')
      this.#db.query(`INSERT INTO commerce_execution_requests (
        request_id, proposal_id, tenant_id, shop_id, idempotency_key, payload_hash, request_json,
        status, lookup_attempts, uncertainty_deadline, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'PREPARED', 0, ?8, ?9, ?9)`).run(
        record.requestId, record.proposalId, record.tenantId, record.shopId, record.idempotencyKey,
        record.payloadHash, JSON.stringify(record.request), record.uncertaintyDeadline, now,
      )
      this.#repository.audit({
        proposalId: proposal.proposalId, traceId: proposal.traceId, actor: input.principal.actorId,
        eventType: 'EXECUTION_PREPARED', fromStatus: 'APPROVED', toStatus: 'EXECUTING',
        details: { requestId: record.requestId }, createdAt: now,
      })
    })
    return this.#send(record, input.principal, input.signal)
  }

  async reconcile(input: { proposalId: string; principal: AuthenticatedPrincipal; signal?: AbortSignal }): Promise<ExecutionRequestRecord> {
    const proposal = this.#repository.getOrThrow(input.proposalId)
    this.#authorize(input.principal, proposal)
    const record = this.getByProposal(proposal.proposalId)
    if (!record) throw new CommerceError('NOT_FOUND', 'Execution request is missing')
    if (!['SENT', 'UNKNOWN'].includes(record.status)) return record
    const capabilities = this.#executor.capabilities()
    if (capabilities.lookup === 'UNAVAILABLE') return this.#manualReview(record, proposal, input.principal, 'Executor lookup is unavailable')
    const outcome = await this.#executor.lookup(record.requestId, input.signal)
    const now = this.#now().toISOString()
    const attempts = record.lookupAttempts + 1
    this.#db.query('UPDATE commerce_execution_requests SET lookup_attempts = ?1, updated_at = ?2 WHERE request_id = ?3')
      .run(attempts, now, record.requestId)
    if (outcome.status === 'APPLIED' || outcome.status === 'REJECTED') {
      return this.#settle(record, proposal, input.principal, outcome)
    }
    if (outcome.status === 'NOT_FOUND' && capabilities.lookup === 'AUTHORITATIVE') {
      return this.#settle(record, proposal, input.principal, { status: 'REJECTED', reason: 'Authoritative lookup found no operation' })
    }
    if (attempts >= this.#maxLookupAttempts || Date.parse(now) >= Date.parse(record.uncertaintyDeadline)) {
      return this.#manualReview(record, proposal, input.principal, `Reconciliation exhausted: ${outcome.status}`)
    }
    const nextLookupAt = new Date(Date.parse(now) + Math.min(60_000, 1_000 * 2 ** (attempts - 1))).toISOString()
    this.#markUnknown(record, proposal, input.principal, outcome.reason ?? outcome.status, nextLookupAt)
    return this.getByProposal(record.proposalId)!
  }

  async #send(record: ExecutionRequestRecord, principal: AuthenticatedPrincipal, signal?: AbortSignal): Promise<ExecutionRequestRecord> {
    const proposal = this.#repository.getOrThrow(record.proposalId)
    const now = this.#now().toISOString()
    this.#db.query("UPDATE commerce_execution_requests SET status = 'SENT', updated_at = ?1 WHERE request_id = ?2 AND status = 'PREPARED'")
      .run(now, record.requestId)
    try {
      const outcome = await this.#executor.execute(record.request, signal)
      if (outcome.status === 'APPLIED' || outcome.status === 'REJECTED') return this.#settle(record, proposal, principal, outcome)
      this.#markUnknown(record, proposal, principal, outcome.reason ?? 'Platform operation is pending')
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      const capabilities = this.#executor.capabilities()
      if (capabilities.idempotency === 'UNSUPPORTED' && capabilities.lookup === 'UNAVAILABLE') {
        return this.#manualReview(record, proposal, principal, reason)
      }
      this.#markUnknown(record, proposal, principal, reason)
    }
    return this.getByProposal(record.proposalId)!
  }

  #settle(record: ExecutionRequestRecord, proposal: Proposal, principal: AuthenticatedPrincipal, outcome: ActionOutcome): ExecutionRequestRecord {
    const requestStatus = outcome.status === 'APPLIED' ? 'APPLIED' : 'REJECTED'
    const proposalStatus = outcome.status === 'APPLIED' ? 'SUCCEEDED' : 'FAILED'
    const now = this.#now().toISOString()
    this.#repository.transaction(() => {
      this.#db.query(`UPDATE commerce_execution_requests SET status = ?1, external_operation_id = ?2,
        result_json = ?3, last_error = NULL, updated_at = ?4 WHERE request_id = ?5`).run(
        requestStatus, outcome.operationId ?? null, JSON.stringify(outcome), now, record.requestId,
      )
      const current = this.#repository.getOrThrow(proposal.proposalId)
      if (current.status === 'EXECUTING' || current.status === 'UNKNOWN') {
        this.#repository.transition(current.proposalId, current.status, proposalStatus)
      }
      this.#repository.audit({
        proposalId: proposal.proposalId, traceId: proposal.traceId, actor: principal.actorId,
        eventType: outcome.status === 'APPLIED' ? 'EXECUTION_SUCCEEDED' : 'EXECUTION_REJECTED',
        fromStatus: current.status, toStatus: proposalStatus,
        details: { requestId: record.requestId, operationId: outcome.operationId, reason: outcome.reason }, createdAt: now,
      })
    })
    return this.getByProposal(record.proposalId)!
  }

  #markUnknown(record: ExecutionRequestRecord, proposal: Proposal, principal: AuthenticatedPrincipal, reason: string, nextLookupAt?: string): void {
    const now = this.#now().toISOString()
    this.#repository.transaction(() => {
      this.#db.query(`UPDATE commerce_execution_requests SET status = 'UNKNOWN', last_error = ?1,
        next_lookup_at = ?2, updated_at = ?3 WHERE request_id = ?4`).run(reason, nextLookupAt ?? now, now, record.requestId)
      const current = this.#repository.getOrThrow(proposal.proposalId)
      if (current.status === 'EXECUTING') this.#repository.transition(current.proposalId, 'EXECUTING', 'UNKNOWN')
      this.#repository.audit({
        proposalId: proposal.proposalId, traceId: proposal.traceId, actor: principal.actorId,
        eventType: 'EXECUTION_RESULT_UNCERTAIN', fromStatus: current.status, toStatus: 'UNKNOWN',
        details: { requestId: record.requestId, reason }, createdAt: now,
      })
    })
  }

  #manualReview(record: ExecutionRequestRecord, proposal: Proposal, principal: AuthenticatedPrincipal, reason: string): ExecutionRequestRecord {
    const now = this.#now().toISOString()
    this.#repository.transaction(() => {
      this.#db.query("UPDATE commerce_execution_requests SET status = 'MANUAL_REVIEW', last_error = ?1, updated_at = ?2 WHERE request_id = ?3")
        .run(reason, now, record.requestId)
      const current = this.#repository.getOrThrow(proposal.proposalId)
      if (current.status === 'EXECUTING' || current.status === 'UNKNOWN') {
        this.#repository.transition(current.proposalId, current.status, 'MANUAL_REVIEW')
      }
      this.#repository.audit({
        proposalId: proposal.proposalId, traceId: proposal.traceId, actor: principal.actorId,
        eventType: 'EXECUTION_MANUAL_REVIEW_REQUIRED', fromStatus: current.status, toStatus: 'MANUAL_REVIEW',
        details: { requestId: record.requestId, reason }, createdAt: now,
      })
    })
    return this.getByProposal(record.proposalId)!
  }

  #authorize(principal: AuthenticatedPrincipal, proposal: Proposal): void {
    if (principal.authSource !== 'service-identity') throw new CommerceError('SCOPE_DENIED', 'Execution requires a dedicated service identity')
    requirePermission(principal, 'proposal:execute')
    requireShopAccess(principal, proposal.shopId)
    if (principal.tenantId !== proposal.tenantId) throw new CommerceError('SCOPE_DENIED', 'Proposal is outside executor tenant scope')
  }
}
