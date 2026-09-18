import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { ApprovalService } from '../src/approvals/approval-service.ts'
import { ProposalRepository, type ExecutionAttempt } from '../src/approvals/repository.ts'
import { ProposalService } from '../src/approvals/proposal-service.ts'
import { assertProposalTransition } from '../src/approvals/state-machine.ts'
import { defaultWorkflowPaths, runDiagnosisCase } from '../src/diagnosis/workflow.ts'
import { ExecutionService } from '../src/execution/execution-service.ts'
import { MockExecutor } from '../src/execution/mock-executor.ts'
import { EvidenceRepository } from '../src/evidence/evidence-repository.ts'
import { ReportRepository } from '../src/reports/report-repository.ts'
import { CommerceDatabase } from '../src/storage/database.ts'
import { localTestPrincipal } from '../src/auth/local-test.ts'
import { IdentityRepository } from '../src/auth/repository.ts'

const temporaryDirectories: string[] = []
const CLOCK = '2026-09-15T10:00:00+08:00'
const EXPIRY = '2026-09-16T10:00:00+08:00'

function temporaryRoot(): string {
  const path = mkdtempSync(resolve(tmpdir(), 'commerce-approval-'))
  temporaryDirectories.push(path)
  return path
}

async function harness(caseName: 'ads-conversion' | 'inventory-shortage' = 'ads-conversion') {
  const root = temporaryRoot()
  const dbPath = resolve(root, 'commerce.sqlite')
  const reportDir = resolve(root, 'reports')
  const persisted = await runDiagnosisCase(caseName, {
    fixtureDir: defaultWorkflowPaths().fixtureDir,
    reportDir,
    dbPath,
    skillSlugs: ['commerce-diagnosis'],
    sourceSlugs: ['commerce'],
  })
  const store = new CommerceDatabase(dbPath)
  const reports = new ReportRepository(reportDir, store)
  const repository = new ProposalRepository(store)
  const clock = { value: CLOCK }
  const now = () => new Date(clock.value)
  const proposals = new ProposalService({ reports, repository, now })
  const approvals = new ApprovalService({ repository, now })
  const executor = new MockExecutor({
    store,
    seedPath: resolve(import.meta.dir, '../fixtures/mock-platform-state.json'),
    now,
  })
  const executions = new ExecutionService({ repository, executor, now })
  const requester = localTestPrincipal({ actorId: 'operator-requester', roles: ['OPERATOR'] })
  const approver = localTestPrincipal({ actorId: 'operator-approver', roles: ['APPROVER'] })
  const executionPrincipal = localTestPrincipal({ actorId: 'execution-service', roles: ['EXECUTOR'], authSource: 'service-identity' })
  return { root, dbPath, reportDir, persisted, store, reports, repository, proposals, approvals, executor, executions, clock, requester, approver, executionPrincipal }
}

async function approvedHarness() {
  const result = await harness()
  const proposal = await result.proposals.create({
    reportId: result.persisted.report.reportId,
    recommendationId: 'rec-ad-budget-review',
    expiresAt: EXPIRY,
    principal: result.requester,
  })
  result.approvals.approve({ proposalId: proposal.proposalId, principal: result.approver, reason: 'Reviewed campaign evidence.', confirmHash: proposal.contentHash })
  return { ...result, proposal: result.repository.getOrThrow(proposal.proposalId) }
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('proposal state machine and mock execution', () => {
  it('allows only declared state transitions', () => {
    expect(() => assertProposalTransition('DRAFT', 'PENDING_APPROVAL')).not.toThrow()
    expect(() => assertProposalTransition('PENDING_APPROVAL', 'SUCCEEDED')).toThrow('Illegal proposal transition')
  })

  it('creates one immutable pending proposal from a RESOLVED report', async () => {
    const result = await harness()
    const input = { reportId: result.persisted.report.reportId, recommendationId: 'rec-ad-budget-review', expiresAt: EXPIRY, principal: result.requester }
    const first = await result.proposals.create(input)
    const second = await result.proposals.create(input)
    expect(first.status).toBe('PENDING_APPROVAL')
    expect(second.proposalId).toBe(first.proposalId)
    expect(result.repository.listAudit(first.proposalId).map(row => row.event_type)).toEqual([
      'PROPOSAL_CREATED', 'SUBMITTED_FOR_APPROVAL',
    ])
  })

  it('rejects proposal creation from a NEEDS_DATA report', async () => {
    const result = await harness('inventory-shortage')
    await expect(result.proposals.create({
      reportId: result.persisted.report.reportId,
      recommendationId: 'rec-inventory-replenishment',
      expiresAt: EXPIRY,
      principal: result.requester,
    })).rejects.toThrow('Only RESOLVED reports')
  })

  it('blocks unapproved, rejected, expired, and tampered proposals', async () => {
    const unapproved = await harness()
    const pending = await unapproved.proposals.create({ reportId: unapproved.persisted.report.reportId, recommendationId: 'rec-ad-budget-review', expiresAt: EXPIRY, principal: unapproved.requester })
    expect(() => unapproved.executions.execute({ proposalId: pending.proposalId, principal: unapproved.executionPrincipal })).toThrow('cannot execute')

    const rejected = await harness()
    const rejectedProposal = await rejected.proposals.create({ reportId: rejected.persisted.report.reportId, recommendationId: 'rec-ad-budget-review', expiresAt: EXPIRY, principal: rejected.requester })
    rejected.approvals.reject({ proposalId: rejectedProposal.proposalId, principal: rejected.approver, reason: 'Budget risk.', confirmHash: rejectedProposal.contentHash })
    expect(() => rejected.executions.execute({ proposalId: rejectedProposal.proposalId, principal: rejected.executionPrincipal })).toThrow('cannot execute')

    const expired = await harness()
    const expiresSoon = await expired.proposals.create({ reportId: expired.persisted.report.reportId, recommendationId: 'rec-ad-budget-review', expiresAt: '2026-09-15T10:30:00+08:00', principal: expired.requester })
    expired.approvals.approve({ proposalId: expiresSoon.proposalId, principal: expired.approver, reason: 'Short-lived approval.', confirmHash: expiresSoon.contentHash })
    expired.clock.value = '2026-09-15T11:00:00+08:00'
    expect(() => expired.executions.execute({ proposalId: expiresSoon.proposalId, principal: expired.executionPrincipal })).toThrow('expired')
    expect(expired.repository.getOrThrow(expiresSoon.proposalId).status).toBe('EXPIRED')

    const tampered = await approvedHarness()
    tampered.store.database.query('UPDATE proposals SET params_json = ?1 WHERE proposal_id = ?2')
      .run(JSON.stringify({ newBudgetMinor: 1, currency: 'CNY', expectedVersion: 1 }), tampered.proposal.proposalId)
    expect(() => tampered.executions.execute({ proposalId: tampered.proposal.proposalId, principal: tampered.executionPrincipal })).toThrow('content hash mismatch')
  })

  it('executes once, returns the first result on retry, and records actor/trace audit', async () => {
    const result = await approvedHarness()
    const first = result.executions.execute({ proposalId: result.proposal.proposalId, principal: result.executionPrincipal })
    const second = result.executions.execute({ proposalId: result.proposal.proposalId, principal: result.executionPrincipal })
    expect(first.proposal.status).toBe('SUCCEEDED')
    expect(second.replayed).toBe(true)
    expect(second.attempt.attemptId).toBe(first.attempt.attemptId)
    expect(result.executor.getState().campaigns['CAMPAIGN-C']?.budgetMinor).toBe(30000)
    const operations = result.store.database.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM mock_operations').get()
    expect(operations?.count).toBe(1)
    const audits = result.repository.listAudit(result.proposal.proposalId)
    expect(audits.some(row => row.actor === 'execution-service' && row.trace_id === 'trace-ads-conversion-001')).toBe(true)
  })

  it('allows only one side effect across concurrent execution calls', async () => {
    const result = await approvedHarness()
    const settled = await Promise.allSettled([
      Promise.resolve().then(() => result.executions.execute({ proposalId: result.proposal.proposalId, principal: result.executionPrincipal })),
      Promise.resolve().then(() => result.executions.execute({ proposalId: result.proposal.proposalId, principal: result.executionPrincipal })),
    ])
    expect(settled.filter(item => item.status === 'fulfilled')).toHaveLength(2)
    const operations = result.store.database.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM mock_operations').get()
    expect(operations?.count).toBe(1)
  })

  it('allows only one terminal decision across concurrent approval calls', async () => {
    const result = await harness()
    const proposal = await result.proposals.create({
      reportId: result.persisted.report.reportId, recommendationId: 'rec-ad-budget-review',
      expiresAt: EXPIRY, principal: result.requester,
    })
    const settled = await Promise.allSettled([
      Promise.resolve().then(() => result.approvals.approve({
        proposalId: proposal.proposalId, principal: result.approver, reason: 'first', confirmHash: proposal.contentHash,
      })),
      Promise.resolve().then(() => result.approvals.reject({
        proposalId: proposal.proposalId, principal: result.approver, reason: 'second', confirmHash: proposal.contentHash,
      })),
    ])
    expect(settled.filter(item => item.status === 'fulfilled')).toHaveLength(1)
    expect(result.store.database.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM approvals').get()?.count).toBe(1)
  })

  it('blocks execution when the original approver authorization was revoked', async () => {
    const result = await approvedHarness()
    const identity = new IdentityRepository(result.store)
    const now = new Date(CLOCK).toISOString()
    identity.upsertMembership({
      subject: result.approver.subject, actorId: result.approver.actorId, tenantId: result.approver.tenantId,
      roles: ['APPROVER'], now,
    })
    identity.setShopGrant({
      subject: result.approver.subject, tenantId: result.approver.tenantId, shopId: 'demo-shop', now,
    })
    identity.upsertMembership({
      subject: result.approver.subject, actorId: result.approver.actorId, tenantId: result.approver.tenantId,
      roles: ['APPROVER'], status: 'REVOKED', now: '2026-09-15T10:01:00.000Z',
    })
    const guarded = new ExecutionService({
      repository: result.repository, executor: result.executor, now: () => new Date(result.clock.value),
      approvalGuard: (proposal, approval) => identity.assertApprovalStillAuthorized(proposal, approval),
    })
    expect(() => guarded.execute({ proposalId: result.proposal.proposalId, principal: result.executionPrincipal })).toThrow('revoked')
    expect(result.repository.getOrThrow(result.proposal.proposalId).status).toBe('APPROVED')
  })

  it('does not repeat a lost-response write and reconciles it from the mock ledger', async () => {
    const result = await approvedHarness()
    const unknown = result.executions.execute({ proposalId: result.proposal.proposalId, principal: result.executionPrincipal, simulateResponseLoss: true })
    expect(unknown.proposal.status).toBe('UNKNOWN')
    const repeat = result.executions.execute({ proposalId: result.proposal.proposalId, principal: result.executionPrincipal })
    expect(repeat.proposal.status).toBe('UNKNOWN')
    expect(repeat.replayed).toBe(true)
    const reconciled = result.executions.reconcile({ proposalId: result.proposal.proposalId, principal: result.executionPrincipal })
    expect(reconciled.status).toBe('SUCCEEDED')
    const operations = result.store.database.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM mock_operations').get()
    expect(operations?.count).toBe(1)
  })

  it('reconciles UNKNOWN to FAILED when the external ledger has no operation', async () => {
    const result = await approvedHarness()
    result.repository.transition(result.proposal.proposalId, 'APPROVED', 'EXECUTING')
    const attempt: ExecutionAttempt = {
      attemptId: 'attempt-no-operation', proposalId: result.proposal.proposalId,
      idempotencyKey: result.proposal.idempotencyKey, status: 'UNKNOWN', createdAt: CLOCK, updatedAt: CLOCK,
    }
    result.repository.insertAttempt(attempt)
    result.repository.transition(result.proposal.proposalId, 'EXECUTING', 'UNKNOWN')
    expect(result.executions.reconcile({ proposalId: result.proposal.proposalId, principal: result.executionPrincipal }).status).toBe('FAILED')
  })

  it('persists evidence and report integrity across repository restarts', async () => {
    const result = await harness()
    const reopenedStore = new CommerceDatabase(result.dbPath)
    const reopenedEvidence = new EvidenceRepository(reopenedStore)
    const evidenceId = result.persisted.report.evidence[0]!.evidenceId
    expect(reopenedEvidence.getOrThrow(evidenceId).evidenceId).toBe(evidenceId)
    expect((await new ReportRepository(result.reportDir, reopenedStore).get(result.persisted.report.reportId)).reportId)
      .toBe(result.persisted.report.reportId)
  })

  it('rejects a persisted report whose JSON no longer matches its content hash', async () => {
    const result = await harness()
    const row = result.store.database.query<{ json: string }, [string]>(
      'SELECT json FROM reports WHERE report_id = ?1',
    ).get(result.persisted.report.reportId)
    const report = JSON.parse(row!.json) as { executiveSummary: { statement: string } }
    report.executiveSummary.statement = 'Tampered after validation.'
    result.store.database.query('UPDATE reports SET json = ?1 WHERE report_id = ?2')
      .run(JSON.stringify(report), result.persisted.report.reportId)
    await expect(result.reports.get(result.persisted.report.reportId)).rejects.toThrow('integrity check failed')
  })
})
