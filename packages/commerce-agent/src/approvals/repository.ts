import { createHash, randomUUID } from 'node:crypto'
import type { Database } from 'bun:sqlite'
import type { ActionType } from '../reports/schema.ts'
import type { CommerceDatabase } from '../storage/database.ts'
import { CommerceError } from '../domain/errors.ts'
import { assertProposalTransition, type ProposalStatus } from './state-machine.ts'

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]))
  }
  return value
}

export function contentDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex')
}

export type Proposal = {
  proposalId: string
  reportId: string
  recommendationId: string
  traceId: string
  evidenceIds: string[]
  actionType: ActionType
  targetId: string
  parameters: Record<string, string | number | boolean>
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH'
  expectedImpact: string
  rollbackPlan: string
  contentHash: string
  idempotencyKey: string
  createdAt: string
  expiresAt: string
  status: ProposalStatus
  version: number
}

export type ProposalContent = Omit<Proposal, 'proposalId' | 'contentHash' | 'idempotencyKey' | 'status'>

export type ApprovalRecord = {
  approvalId: string
  proposalId: string
  decision: 'APPROVED' | 'REJECTED'
  actor: string
  reason: string
  contentHash: string
  createdAt: string
}

export type ExecutionAttempt = {
  attemptId: string
  proposalId: string
  idempotencyKey: string
  status: 'EXECUTING' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN'
  externalOperationId?: string
  before?: unknown
  after?: unknown
  result?: unknown
  createdAt: string
  updatedAt: string
}

type ProposalRow = {
  proposal_id: string; report_id: string; recommendation_id: string; trace_id: string
  evidence_ids_json: string; action_type: ActionType; target_id: string; params_json: string
  risk_level: Proposal['riskLevel']; expected_impact: string; rollback_plan: string
  content_hash: string; idempotency_key: string; created_at: string; expires_at: string
  status: ProposalStatus; version: number
}

type ApprovalRow = {
  approval_id: string; proposal_id: string; decision: ApprovalRecord['decision']; actor: string
  reason: string; content_hash: string; created_at: string
}

type AttemptRow = {
  attempt_id: string; proposal_id: string; idempotency_key: string; status: ExecutionAttempt['status']
  external_operation_id: string | null; before_json: string | null; after_json: string | null
  result_json: string | null; created_at: string; updated_at: string
}

function proposalFromRow(row: ProposalRow): Proposal {
  return {
    proposalId: row.proposal_id,
    reportId: row.report_id,
    recommendationId: row.recommendation_id,
    traceId: row.trace_id,
    evidenceIds: JSON.parse(row.evidence_ids_json) as string[],
    actionType: row.action_type,
    targetId: row.target_id,
    parameters: JSON.parse(row.params_json) as Proposal['parameters'],
    riskLevel: row.risk_level,
    expectedImpact: row.expected_impact,
    rollbackPlan: row.rollback_plan,
    contentHash: row.content_hash,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    status: row.status,
    version: row.version,
  }
}

function attemptFromRow(row: AttemptRow): ExecutionAttempt {
  return {
    attemptId: row.attempt_id,
    proposalId: row.proposal_id,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    externalOperationId: row.external_operation_id ?? undefined,
    before: row.before_json ? JSON.parse(row.before_json) : undefined,
    after: row.after_json ? JSON.parse(row.after_json) : undefined,
    result: row.result_json ? JSON.parse(row.result_json) : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function proposalContent(proposal: Proposal): ProposalContent {
  const { proposalId: _proposalId, contentHash: _contentHash, idempotencyKey: _idempotencyKey, status: _status, ...content } = proposal
  return content
}

export function assertProposalIntegrity(proposal: Proposal): void {
  if (contentDigest(proposalContent(proposal)) !== proposal.contentHash) {
    throw new CommerceError('INVALID_ARGUMENT', `Proposal content hash mismatch: ${proposal.proposalId}`)
  }
}

export class ProposalRepository {
  readonly #db: Database

  constructor(store: CommerceDatabase) {
    this.#db = store.database
  }

  transaction<T>(operation: () => T): T {
    return this.#db.transaction(operation).immediate()
  }

  insert(proposal: Proposal): Proposal {
    this.#db.query(`
      INSERT INTO proposals (
        proposal_id, report_id, recommendation_id, trace_id, evidence_ids_json, action_type,
        target_id, params_json, risk_level, expected_impact, rollback_plan, content_hash,
        idempotency_key, created_at, expires_at, status, version
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
    `).run(
      proposal.proposalId, proposal.reportId, proposal.recommendationId, proposal.traceId,
      JSON.stringify(proposal.evidenceIds), proposal.actionType, proposal.targetId,
      JSON.stringify(proposal.parameters), proposal.riskLevel, proposal.expectedImpact,
      proposal.rollbackPlan, proposal.contentHash, proposal.idempotencyKey, proposal.createdAt,
      proposal.expiresAt, proposal.status, proposal.version,
    )
    return proposal
  }

  get(proposalId: string): Proposal | undefined {
    const row = this.#db.query<ProposalRow, [string]>('SELECT * FROM proposals WHERE proposal_id = ?1').get(proposalId)
    return row ? proposalFromRow(row) : undefined
  }

  getOrThrow(proposalId: string): Proposal {
    const proposal = this.get(proposalId)
    if (!proposal) throw new CommerceError('NOT_FOUND', `Proposal not found: ${proposalId}`)
    return proposal
  }

  findByReportRecommendation(reportId: string, recommendationId: string): Proposal | undefined {
    const row = this.#db.query<ProposalRow, [string, string]>(
      'SELECT * FROM proposals WHERE report_id = ?1 AND recommendation_id = ?2',
    ).get(reportId, recommendationId)
    return row ? proposalFromRow(row) : undefined
  }

  transition(proposalId: string, from: ProposalStatus, to: ProposalStatus): Proposal {
    assertProposalTransition(from, to)
    const result = this.#db.query(
      'UPDATE proposals SET status = ?1 WHERE proposal_id = ?2 AND status = ?3',
    ).run(to, proposalId, from)
    if (result.changes !== 1) {
      const current = this.getOrThrow(proposalId)
      throw new CommerceError('INVALID_ARGUMENT', `Proposal transition lost concurrency race: expected ${from}, found ${current.status}`)
    }
    return this.getOrThrow(proposalId)
  }

  insertApproval(record: ApprovalRecord): void {
    this.#db.query(`
      INSERT INTO approvals (approval_id, proposal_id, decision, actor, reason, content_hash, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
    `).run(record.approvalId, record.proposalId, record.decision, record.actor, record.reason, record.contentHash, record.createdAt)
  }

  latestApproval(proposalId: string): ApprovalRecord | undefined {
    const row = this.#db.query<ApprovalRow, [string]>(
      'SELECT * FROM approvals WHERE proposal_id = ?1 ORDER BY created_at DESC LIMIT 1',
    ).get(proposalId)
    return row ? {
      approvalId: row.approval_id,
      proposalId: row.proposal_id,
      decision: row.decision,
      actor: row.actor,
      reason: row.reason,
      contentHash: row.content_hash,
      createdAt: row.created_at,
    } : undefined
  }

  insertAttempt(attempt: ExecutionAttempt): void {
    this.#db.query(`
      INSERT INTO execution_attempts (
        attempt_id, proposal_id, idempotency_key, status, external_operation_id,
        before_json, after_json, result_json, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
    `).run(
      attempt.attemptId, attempt.proposalId, attempt.idempotencyKey, attempt.status,
      attempt.externalOperationId ?? null, attempt.before === undefined ? null : JSON.stringify(attempt.before),
      attempt.after === undefined ? null : JSON.stringify(attempt.after),
      attempt.result === undefined ? null : JSON.stringify(attempt.result), attempt.createdAt, attempt.updatedAt,
    )
  }

  updateAttempt(attemptId: string, update: Partial<ExecutionAttempt> & { status: ExecutionAttempt['status']; updatedAt: string }): void {
    const current = this.getAttemptById(attemptId)
    if (!current) throw new CommerceError('NOT_FOUND', `Execution attempt not found: ${attemptId}`)
    const merged = { ...current, ...update }
    this.#db.query(`
      UPDATE execution_attempts SET status = ?1, external_operation_id = ?2,
        before_json = ?3, after_json = ?4, result_json = ?5, updated_at = ?6
      WHERE attempt_id = ?7
    `).run(
      merged.status, merged.externalOperationId ?? null,
      merged.before === undefined ? null : JSON.stringify(merged.before),
      merged.after === undefined ? null : JSON.stringify(merged.after),
      merged.result === undefined ? null : JSON.stringify(merged.result), merged.updatedAt, attemptId,
    )
  }

  getAttemptById(attemptId: string): ExecutionAttempt | undefined {
    const row = this.#db.query<AttemptRow, [string]>('SELECT * FROM execution_attempts WHERE attempt_id = ?1').get(attemptId)
    return row ? attemptFromRow(row) : undefined
  }

  getAttemptByIdempotencyKey(key: string): ExecutionAttempt | undefined {
    const row = this.#db.query<AttemptRow, [string]>(
      'SELECT * FROM execution_attempts WHERE idempotency_key = ?1',
    ).get(key)
    return row ? attemptFromRow(row) : undefined
  }

  audit(input: {
    proposalId: string; traceId: string; actor: string; eventType: string
    fromStatus?: ProposalStatus; toStatus?: ProposalStatus; details?: unknown; createdAt: string
  }): void {
    this.#db.query(`
      INSERT INTO audit_events (
        proposal_id, trace_id, actor, event_type, from_status, to_status, details_json, created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
    `).run(
      input.proposalId, input.traceId, input.actor, input.eventType,
      input.fromStatus ?? null, input.toStatus ?? null, JSON.stringify(input.details ?? {}), input.createdAt,
    )
  }

  listAudit(proposalId: string): Array<Record<string, unknown>> {
    return this.#db.query<Record<string, unknown>, [string]>(
      'SELECT * FROM audit_events WHERE proposal_id = ?1 ORDER BY event_id',
    ).all(proposalId)
  }

  createApprovalId(): string {
    return `approval_${randomUUID()}`
  }
}
