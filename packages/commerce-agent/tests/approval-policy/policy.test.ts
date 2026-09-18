import { describe, expect, it } from 'bun:test'
import { localTestPrincipal } from '../../src/auth/local-test.ts'
import { ApprovalPolicy, APPROVAL_POLICY_VERSION } from '../../src/approvals/policy.ts'
import { contentDigest, type Proposal, type ProposalContent } from '../../src/approvals/repository.ts'

function proposal(overrides: Partial<Proposal> = {}): Proposal {
  const content: ProposalContent = {
    reportId: 'report_123456789012345678901234', recommendationId: 'rec-1', traceId: 'trace-1',
    tenantId: 'tenant-a', shopId: 'shop-a', requestedBy: 'requester-1', snapshotId: 'snapshot-1',
    reviewStatus: 'REVIEWED', policyVersion: APPROVAL_POLICY_VERSION, targetVersion: 1,
    evidenceIds: ['ev_123456789012345678901234'], actionType: 'ADJUST_AD_BUDGET', targetId: 'campaign-1',
    parameters: { newBudgetMinor: 30_000, currency: 'CNY', expectedVersion: 1 }, riskLevel: 'MEDIUM',
    expectedImpact: 'Recover conversion volume', rollbackPlan: 'Restore previous budget',
    createdAt: '2026-09-18T08:00:00.000Z', expiresAt: '2026-09-18T10:00:00.000Z', version: 1,
  }
  const merged = { ...content, ...overrides }
  return {
    ...merged, proposalId: 'proposal-1', status: 'PENDING_APPROVAL',
    contentHash: contentDigest(merged), idempotencyKey: contentDigest({ proposal: 'proposal-1' }),
  }
}

const policy = new ApprovalPolicy({ maxBudgetMinor: 100_000 })
const approver = localTestPrincipal({
  actorId: 'approver-1', subject: 'oidc|approver-1', tenantId: 'tenant-a', shopIds: ['shop-a'],
  roles: ['APPROVER'], authSource: 'oidc-session',
})

describe('approval policy', () => {
  it('allows a reviewed, hash-confirmed proposal for a distinct scoped approver', () => {
    const item = proposal()
    expect(policy.evaluate({ proposal: item, principal: approver, confirmHash: item.contentHash, decision: 'APPROVED', now: '2026-09-18T09:00:00.000Z' })).toBe('ALLOW')
  })

  it('enforces separation of duties, content confirmation, scope, and action limits', () => {
    const self = proposal({ requestedBy: 'approver-1' })
    expect(() => policy.evaluate({ proposal: self, principal: approver, confirmHash: self.contentHash, decision: 'APPROVED', now: '2026-09-18T09:00:00.000Z' })).toThrow('requester')
    const item = proposal()
    expect(() => policy.evaluate({ proposal: item, principal: approver, confirmHash: '0'.repeat(64), decision: 'APPROVED', now: '2026-09-18T09:00:00.000Z' })).toThrow('hash')
    const excessive = proposal({ parameters: { newBudgetMinor: 100_001, currency: 'CNY', expectedVersion: 1 } })
    expect(() => policy.evaluate({ proposal: excessive, principal: approver, confirmHash: excessive.contentHash, decision: 'APPROVED', now: '2026-09-18T09:00:00.000Z' })).toThrow('exceeds')
    const admin = localTestPrincipal({ actorId: 'admin-1', tenantId: 'tenant-a', shopIds: ['shop-a'], roles: ['ADMIN'], authSource: 'oidc-session' })
    expect(() => policy.evaluate({ proposal: item, principal: admin, confirmHash: item.contentHash, decision: 'APPROVED', now: '2026-09-18T09:00:00.000Z' })).toThrow('cannot make')
  })

  it('blocks pending evidence review and confines legacy bypass to explicit local tests', () => {
    const pending = proposal({ reviewStatus: 'PENDING_REVIEW' })
    expect(() => policy.evaluate({ proposal: pending, principal: approver, confirmHash: pending.contentHash, decision: 'APPROVED', now: '2026-09-18T09:00:00.000Z' })).toThrow('Evidence review')
    const legacy = proposal({ reviewStatus: 'LEGACY_DEMO', snapshotId: 'LEGACY_DEMO' })
    const localApprover = localTestPrincipal({ actorId: 'approver-1', tenantId: 'tenant-a', shopIds: ['shop-a'], roles: ['APPROVER'] })
    expect(policy.evaluate({ proposal: legacy, principal: localApprover, confirmHash: legacy.contentHash, decision: 'APPROVED', now: '2026-09-18T09:00:00.000Z' })).toBe('ALLOW_LEGACY_TEST')
  })
})
