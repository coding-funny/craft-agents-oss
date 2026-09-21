import { CommerceError } from '../domain/errors.ts'
import type { AuthenticatedPrincipal } from '../auth/contracts.ts'
import { requirePermission, requireShopAccess } from '../auth/authorization.ts'
import type { Proposal } from './repository.ts'

export const APPROVAL_POLICY_VERSION = 'approval-policy-v1'

export type ApprovalReasonCode =
  | 'ALLOW'
  | 'ALLOW_LEGACY_TEST'
  | 'DENY_PERMISSION'
  | 'DENY_SCOPE'
  | 'DENY_SEPARATION_OF_DUTIES'
  | 'DENY_HASH_MISMATCH'
  | 'DENY_EXPIRED'
  | 'DENY_POLICY_VERSION'
  | 'DENY_ACTION_LIMIT'
  | 'DENY_REVIEW_PENDING'
  | 'DENY_STALE_TARGET'

export class ApprovalPolicyError extends CommerceError {
  readonly reasonCode: ApprovalReasonCode

  constructor(reasonCode: ApprovalReasonCode, message: string) {
    super('SCOPE_DENIED', message)
    this.reasonCode = reasonCode
  }
}

function deny(reasonCode: ApprovalReasonCode, message: string): never {
  throw new ApprovalPolicyError(reasonCode, message)
}

export class ApprovalPolicy {
  readonly #maxBudgetMinor: number

  constructor(options: { maxBudgetMinor?: number } = {}) {
    this.#maxBudgetMinor = options.maxBudgetMinor ?? 500_000
  }

  evaluate(input: {
    proposal: Proposal; principal: AuthenticatedPrincipal; confirmHash: string
    decision: 'APPROVED' | 'REJECTED'; now: string
  }): ApprovalReasonCode {
    try {
      requirePermission(input.principal, input.decision === 'APPROVED' ? 'proposal:approve' : 'proposal:reject')
    } catch { deny('DENY_PERMISSION', 'Principal cannot make this approval decision') }
    try { requireShopAccess(input.principal, input.proposal.shopId) }
    catch { deny('DENY_SCOPE', 'Proposal is outside principal shop scope') }
    if (input.principal.tenantId !== input.proposal.tenantId) deny('DENY_SCOPE', 'Proposal is outside principal tenant scope')
    if (input.proposal.requestedBy === input.principal.actorId) {
      deny('DENY_SEPARATION_OF_DUTIES', 'Proposal requester cannot approve or reject the same proposal')
    }
    if (input.confirmHash !== input.proposal.contentHash) deny('DENY_HASH_MISMATCH', 'Confirmation hash does not match proposal content')
    if (Date.parse(input.proposal.expiresAt) <= Date.parse(input.now)) deny('DENY_EXPIRED', 'Proposal has expired')
    if (input.proposal.policyVersion !== APPROVAL_POLICY_VERSION) deny('DENY_POLICY_VERSION', 'Proposal policy version is stale')
    if (!Number.isSafeInteger(input.proposal.targetVersion) || input.proposal.targetVersion < 1) {
      deny('DENY_STALE_TARGET', 'Proposal target version is invalid')
    }
    if (input.proposal.reviewStatus !== 'REVIEWED') {
      if (input.proposal.reviewStatus === 'LEGACY_DEMO' && input.principal.authSource === 'local-test') return 'ALLOW_LEGACY_TEST'
      deny('DENY_REVIEW_PENDING', 'Evidence review must complete before approval')
    }
    if (input.decision === 'APPROVED' && input.proposal.actionType === 'ADJUST_AD_BUDGET') {
      const amount = input.proposal.parameters.newBudgetMinor
      if (typeof amount !== 'number' || amount > this.#maxBudgetMinor) {
        deny('DENY_ACTION_LIMIT', 'Requested budget exceeds approval policy limit')
      }
    }
    return 'ALLOW'
  }
}
