import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { ApprovalService } from '../../src/approvals/approval-service.ts'
import { contentDigest, proposalContent, ProposalRepository, type Proposal } from '../../src/approvals/repository.ts'
import { localTestPrincipal } from '../../src/auth/local-test.ts'
import type { ActionExecutor } from '../../src/execution/action-executor.ts'
import { HttpActionExecutor } from '../../src/execution/http-executor.ts'
import { ReliableExecutionService } from '../../src/execution/reliable-execution-service.ts'
import { CommerceDatabase } from '../../src/storage/database.ts'
import { TestCommercePlatform } from '../support/test-platform.ts'

const roots: string[] = []
const NOW = '2026-09-18T00:00:00.000Z'
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function harness(targetVersion = 1) {
  const root = mkdtempSync(resolve(tmpdir(), 'commerce-http-execution-'))
  roots.push(root)
  const store = new CommerceDatabase(resolve(root, 'local.sqlite'))
  const repository = new ProposalRepository(store)
  const base: Proposal = {
    proposalId: 'proposal-1', reportId: 'report-1', recommendationId: 'rec-1', traceId: 'trace-1',
    tenantId: 'local-tenant', shopId: 'demo-shop', requestedBy: 'operator', snapshotId: 'snapshot-1',
    reviewStatus: 'REVIEWED', policyVersion: 'approval-policy-v1', targetVersion, evidenceIds: ['evidence-1'],
    actionType: 'ADJUST_AD_BUDGET', targetId: 'CAMPAIGN-C',
    parameters: { newBudgetMinor: 30000, currency: 'CNY', expectedVersion: targetVersion },
    riskLevel: 'MEDIUM', expectedImpact: 'Reduce waste', rollbackPlan: 'Restore budget',
    contentHash: '', idempotencyKey: 'idem-1', createdAt: NOW, expiresAt: '2026-09-19T00:00:00.000Z',
    status: 'PENDING_APPROVAL', version: 1,
  }
  base.contentHash = contentDigest(proposalContent(base))
  repository.insert(base)
  const approver = localTestPrincipal({ actorId: 'approver', roles: ['APPROVER'] })
  new ApprovalService({ repository, now: () => new Date(NOW) }).approve({
    proposalId: base.proposalId, principal: approver, reason: 'Evidence reviewed', confirmHash: base.contentHash,
  })
  const principal = localTestPrincipal({ actorId: 'executor', roles: ['EXECUTOR'], authSource: 'service-identity' })
  const platform = new TestCommercePlatform(resolve(root, 'remote.sqlite'))
  const executor = new HttpActionExecutor({
    baseUrl: platform.baseUrl, capabilities: { idempotency: 'SUPPORTED', lookup: 'EVENTUAL', visibilityLagMs: 1_000 },
  })
  const service = new ReliableExecutionService({
    database: store.database, repository, executor, now: () => new Date(NOW), approvalGuard: () => {},
  })
  return { store, repository, principal, platform, service }
}

describe('reliable HTTP execution', () => {
  it('reconciles apply-then-response-loss without a duplicate remote effect', async () => {
    const result = harness()
    result.platform.mode = 'APPLY_THEN_ERROR'
    expect((await result.service.execute({ proposalId: 'proposal-1', principal: result.principal })).status).toBe('UNKNOWN')
    expect(result.repository.getOrThrow('proposal-1').status).toBe('UNKNOWN')
    result.platform.mode = 'NORMAL'
    expect((await result.service.reconcile({ proposalId: 'proposal-1', principal: result.principal })).status).toBe('APPLIED')
    expect(result.repository.getOrThrow('proposal-1').status).toBe('SUCCEEDED')
    expect(result.platform.posts).toBe(1)
    expect(result.platform.effectCount()).toBe(1)
    result.platform.close(); result.store.close()
  })

  it('keeps eventual NOT_FOUND unknown and never blindly resends', async () => {
    const result = harness()
    result.platform.mode = 'APPLY_THEN_ERROR'
    result.platform.visibilityMisses = 1
    await result.service.execute({ proposalId: 'proposal-1', principal: result.principal })
    expect((await result.service.reconcile({ proposalId: 'proposal-1', principal: result.principal })).status).toBe('UNKNOWN')
    expect(result.platform.posts).toBe(1)
    expect((await result.service.reconcile({ proposalId: 'proposal-1', principal: result.principal })).status).toBe('APPLIED')
    expect(result.platform.effectCount()).toBe(1)
    result.platform.close(); result.store.close()
  })

  it('resumes a persisted PREPARED request after a crash before send', async () => {
    const result = harness()
    const proposal = result.repository.getOrThrow('proposal-1')
    const request = {
      requestId: 'request-prepared', idempotencyKey: proposal.idempotencyKey,
      tenantId: proposal.tenantId, shopId: proposal.shopId, proposalId: proposal.proposalId,
      actionType: proposal.actionType, targetId: proposal.targetId, expectedVersion: proposal.targetVersion,
      parameters: proposal.parameters, contentHash: proposal.contentHash,
    }
    result.repository.transaction(() => {
      result.repository.transition(proposal.proposalId, 'APPROVED', 'EXECUTING')
      result.store.database.query(`INSERT INTO commerce_execution_requests (
        request_id, proposal_id, tenant_id, shop_id, idempotency_key, payload_hash, request_json,
        status, lookup_attempts, uncertainty_deadline, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'PREPARED', 0, ?8, ?9, ?9)`).run(
        request.requestId, request.proposalId, request.tenantId, request.shopId,
        request.idempotencyKey, contentDigest(request), JSON.stringify(request),
        '2026-09-19T00:00:00.000Z', NOW,
      )
    })
    expect((await result.service.execute({ proposalId: proposal.proposalId, principal: result.principal })).status).toBe('APPLIED')
    expect(result.platform.posts).toBe(1)
    expect(result.platform.effectCount()).toBe(1)
    result.platform.close(); result.store.close()
  })

  it('rejects a stale expectedVersion atomically without changing remote state', async () => {
    const result = harness(9)
    const request = await result.service.execute({ proposalId: 'proposal-1', principal: result.principal })
    expect(request.status).toBe('REJECTED')
    expect(result.repository.getOrThrow('proposal-1').status).toBe('FAILED')
    expect(result.platform.effectCount()).toBe(0)
    result.platform.close(); result.store.close()
  })

  it('rejects reuse of one idempotency key with a different payload', async () => {
    const result = harness()
    const applied = await result.service.execute({ proposalId: 'proposal-1', principal: result.principal })
    const executor = new HttpActionExecutor({
      baseUrl: result.platform.baseUrl, capabilities: { idempotency: 'SUPPORTED', lookup: 'AUTHORITATIVE' },
    })
    const conflict = await executor.execute({
      ...applied.request, parameters: { ...applied.request.parameters, newBudgetMinor: 1 },
    })
    expect(conflict.status).toBe('REJECTED')
    expect(conflict.reason).toBe('IDEMPOTENCY_PAYLOAD_MISMATCH')
    expect(result.platform.effectCount()).toBe(1)
    result.platform.close(); result.store.close()
  })

  it('routes uncertain writes to manual review when idempotency and lookup are unavailable', async () => {
    const result = harness()
    const unsafe: ActionExecutor = {
      capabilities: () => ({ idempotency: 'UNSUPPORTED', lookup: 'UNAVAILABLE' }),
      execute: async () => { throw new Error('connection-reset') },
      lookup: async () => ({ status: 'UNAVAILABLE' }),
    }
    const service = new ReliableExecutionService({
      database: result.store.database, repository: result.repository, executor: unsafe, now: () => new Date(NOW),
      approvalGuard: () => {},
    })
    expect((await service.execute({ proposalId: 'proposal-1', principal: result.principal })).status).toBe('MANUAL_REVIEW')
    expect(result.repository.getOrThrow('proposal-1').status).toBe('MANUAL_REVIEW')
    result.platform.close(); result.store.close()
  })

  it('fails closed when approval authorization was revoked before preparing a request', async () => {
    const result = harness()
    const executor = new HttpActionExecutor({
      baseUrl: result.platform.baseUrl, capabilities: { idempotency: 'SUPPORTED', lookup: 'AUTHORITATIVE' },
    })
    const guarded = new ReliableExecutionService({
      database: result.store.database, repository: result.repository, executor, now: () => new Date(NOW),
      approvalGuard: () => { throw new Error('approver authorization revoked') },
    })
    await expect(guarded.execute({ proposalId: 'proposal-1', principal: result.principal })).rejects.toThrow('revoked')
    expect(result.store.database.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM commerce_execution_requests').get()?.count).toBe(0)
    expect(result.platform.posts).toBe(0)
    result.platform.close(); result.store.close()
  })
})
