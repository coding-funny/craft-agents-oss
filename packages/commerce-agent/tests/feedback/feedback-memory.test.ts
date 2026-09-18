import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { localTestPrincipal } from '../../src/auth/local-test.ts'
import { FeedbackService } from '../../src/feedback/service.ts'
import { CaseMemoryRepository } from '../../src/memory/case-memory.ts'
import { CommerceDatabase } from '../../src/storage/database.ts'

const report = { reportId: 'report_feedback_001', evidence: [{ evidenceId: 'ev-1' }], anomalies: [{ factId: 'fact-1' }], hypotheses: [{ hypothesisId: 'hyp-1' }], recommendations: [{ recommendationId: 'rec-1' }] }
const version = createHash('sha256').update(JSON.stringify(report)).digest('hex')

function setup() {
  const store = new CommerceDatabase(':memory:'); const db = store.database
  db.query(`INSERT INTO investigation_tasks (task_id,version,tenant_id,requested_by,input_json,resolved_scope_json,as_of,fixture_digest,budget_json,created_at,updated_at)
    VALUES ('task-a',1,'tenant-a','operator-a','{}','{"shopId":"shop-a"}','2026-09-18T00:00:00Z','digest','{}','2026-09-18T00:00:00Z','2026-09-18T00:00:00Z')`).run()
  db.query(`INSERT INTO investigation_runs (run_id,task_id,attempt,trace_id,status,report_id,created_at,updated_at)
    VALUES ('run-a','task-a',1,'trace-a','REPORT_READY',?1,'2026-09-18T00:00:00Z','2026-09-18T00:00:00Z')`).run(report.reportId)
  db.query('INSERT INTO reports (report_id,case_id,trace_id,content_hash,json,created_at) VALUES (?1,?2,?3,?4,?5,?6)').run(report.reportId, 'case-a', 'trace-a', version, JSON.stringify(report), '2026-09-18T00:00:00Z')
  return store
}

describe('feedback and reviewed case memory', () => {
  it('stores feedback idempotently and sends only failure feedback to the review pool', () => {
    const store = setup(); const service = new FeedbackService(store, () => new Date('2026-09-18T01:00:00Z'))
    const principal = localTestPrincipal({ actorId: 'operator-a', roles: ['OPERATOR'], tenantId: 'tenant-a', shopIds: ['shop-a'] })
    const input = { taskId: 'task-a', reportId: report.reportId, reportVersion: version, claimId: 'fact-1', evidenceId: 'ev-1', kind: 'INCORRECT_CONCLUSION', notes: '该结论与人工复核结果不一致', idempotencyKey: 'feedback-key-0001' }
    const first = service.submit(principal, input); const replay = service.submit(principal, input)
    expect(first.evaluationCandidate).toBe(true); expect(replay.replayed).toBe(true)
    expect(store.database.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM commerce_eval_candidates').get()?.count).toBe(1)
  })

  it('rejects stale versions, unrelated claims, and idempotency key mutation', () => {
    const store = setup(); const service = new FeedbackService(store)
    const principal = localTestPrincipal({ actorId: 'operator-a', roles: ['OPERATOR'], tenantId: 'tenant-a', shopIds: ['shop-a'] })
    const base = { taskId: 'task-a', reportId: report.reportId, reportVersion: version, kind: 'CORRECTION', notes: '人工核对后需要修正结论', idempotencyKey: 'feedback-key-0002' }
    expect(() => service.submit(principal, { ...base, reportVersion: 'a'.repeat(64) })).toThrow('stale')
    expect(() => service.submit(principal, { ...base, claimId: 'other' })).toThrow('Claim')
    service.submit(principal, base)
    expect(() => service.submit(principal, { ...base, notes: '使用同一个键提交不同内容' })).toThrow('Idempotency')
  })

  it('retrieves only reviewed, unexpired memory inside the exact tenant and shop scope', () => {
    const store = setup(); let now = new Date('2026-09-18T01:00:00Z'); const memory = new CaseMemoryRepository(store, () => now)
    const reviewer = localTestPrincipal({ actorId: 'reviewer-a', roles: ['APPROVER'], tenantId: 'tenant-a', shopIds: ['shop-a'] })
    const operator = localTestPrincipal({ actorId: 'operator-a', roles: ['OPERATOR'], tenantId: 'tenant-a', shopIds: ['shop-a'] })
    memory.saveReviewed(reviewer, { shopId: 'shop-a', entityType: 'SKU', entityId: 'sku-a', anomalyType: 'SALES_INVENTORY', outcome: 'Confirmed stock constraint', reportId: report.reportId, evidenceIds: ['ev-1'], validUntil: '2026-10-01T00:00:00Z' })
    expect(memory.search(operator, { shopId: 'shop-a', entityId: 'sku-a' })).toHaveLength(1)
    now = new Date('2026-10-02T00:00:00Z')
    expect(memory.search(operator, { shopId: 'shop-a', entityId: 'sku-a' })).toHaveLength(0)
    const otherShop = localTestPrincipal({ actorId: 'operator-b', roles: ['OPERATOR'], tenantId: 'tenant-a', shopIds: ['shop-b'] })
    expect(() => memory.search(otherShop, { shopId: 'shop-a' })).toThrow('scope')
  })
})
