import { createHash, randomUUID } from 'node:crypto'
import type { Database } from 'bun:sqlite'
import type { AuthenticatedPrincipal } from '../auth/contracts.ts'
import { requirePermission, requireShopAccess } from '../auth/authorization.ts'
import { CommerceError } from '../domain/errors.ts'
import type { CommerceDatabase } from '../storage/database.ts'
import { SubmitFeedbackSchema } from './contracts.ts'

type FeedbackRow = { feedback_id: string; payload_hash: string }
type ReportRow = { tenant_id: string; shop_id: string; content_hash: string; json: string }

function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }

export class FeedbackService {
  readonly #db: Database
  constructor(store: CommerceDatabase, private readonly now: () => Date = () => new Date()) { this.#db = store.database }

  submit(principal: AuthenticatedPrincipal, value: unknown) {
    requirePermission(principal, 'report:read')
    const input = SubmitFeedbackSchema.parse(value)
    const report = this.#db.query<ReportRow, [string, string]>(`SELECT t.tenant_id,
      json_extract(t.resolved_scope_json,'$.shopId') AS shop_id, p.content_hash, p.json
      FROM investigation_tasks t JOIN investigation_runs r ON r.task_id=t.task_id
      JOIN reports p ON p.report_id=r.report_id WHERE t.task_id=?1 AND p.report_id=?2 LIMIT 1`).get(input.taskId, input.reportId)
    if (!report || report.tenant_id !== principal.tenantId) throw new CommerceError('NOT_FOUND', 'Feedback target not found')
    requireShopAccess(principal, report.shop_id)
    if (report.content_hash !== input.reportVersion) throw new CommerceError('INVALID_ARGUMENT', 'Report version is stale; refresh before sending feedback')
    const parsed = JSON.parse(report.json) as { evidence?: Array<{ evidenceId: string }>; anomalies?: Array<{ factId?: string }>; hypotheses?: Array<{ hypothesisId?: string }>; recommendations?: Array<{ recommendationId?: string }> }
    if (input.evidenceId && !parsed.evidence?.some(item => item.evidenceId === input.evidenceId)) throw new CommerceError('INVALID_ARGUMENT', 'Evidence is not part of this report version')
    if (input.claimId) {
      const ids = [...(parsed.anomalies ?? []).map(item => item.factId), ...(parsed.hypotheses ?? []).map(item => item.hypothesisId), ...(parsed.recommendations ?? []).map(item => item.recommendationId)]
      if (!ids.includes(input.claimId)) throw new CommerceError('INVALID_ARGUMENT', 'Claim is not part of this report version')
    }
    const payloadHash = digest(input)
    const existing = this.#db.query<FeedbackRow, [string, string, string]>('SELECT feedback_id,payload_hash FROM commerce_feedback WHERE tenant_id=?1 AND actor_id=?2 AND idempotency_key=?3').get(principal.tenantId, principal.actorId, input.idempotencyKey)
    if (existing) {
      if (existing.payload_hash !== payloadHash) throw new CommerceError('INVALID_ARGUMENT', 'Idempotency key was reused with different feedback')
      return { feedbackId: existing.feedback_id, replayed: true }
    }
    const feedbackId = `feedback_${randomUUID()}`
    const now = this.now().toISOString()
    const candidateKinds = new Set(['INCORRECT_CONCLUSION', 'MISSING_DATA', 'CORRECTION'])
    this.#db.transaction(() => {
      this.#db.query(`INSERT INTO commerce_feedback (feedback_id,tenant_id,shop_id,task_id,report_id,report_version,claim_id,evidence_id,
        kind,notes,actor_id,actor_role,idempotency_key,payload_hash,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)`).run(
        feedbackId, principal.tenantId, report.shop_id, input.taskId, input.reportId, input.reportVersion,
        input.claimId ?? null, input.evidenceId ?? null, input.kind, input.notes, principal.actorId, principal.roles.join(','), input.idempotencyKey, payloadHash, now)
      if (candidateKinds.has(input.kind)) this.#db.query(`INSERT INTO commerce_eval_candidates
        (candidate_id,feedback_id,tenant_id,shop_id,source_task_id,status,sanitized_payload_json,created_at)
        VALUES (?1,?2,?3,?4,?5,'PENDING_REVIEW',?6,?7)`).run(
          `candidate_${randomUUID()}`, feedbackId, principal.tenantId, report.shop_id, input.taskId,
          JSON.stringify({ kind: input.kind, taskId: input.taskId, reportId: input.reportId, claimId: input.claimId, evidenceId: input.evidenceId }), now)
    }).immediate()
    return { feedbackId, replayed: false, evaluationCandidate: candidateKinds.has(input.kind) }
  }

  listCandidates(principal: AuthenticatedPrincipal) {
    requirePermission(principal, 'audit:read')
    if (principal.allowedShopIds.length === 0) return []
    const placeholders = principal.allowedShopIds.map(() => '?').join(',')
    return this.#db.query<Record<string, unknown>, string[]>(`SELECT candidate_id AS candidateId,feedback_id AS feedbackId,shop_id AS shopId,
      source_task_id AS sourceTaskId,status,sanitized_payload_json AS sanitizedPayload,created_at AS createdAt,reviewed_at AS reviewedAt
      FROM commerce_eval_candidates WHERE tenant_id=? AND shop_id IN (${placeholders}) ORDER BY created_at DESC LIMIT 100`)
      .all(principal.tenantId, ...principal.allowedShopIds)
  }
}
