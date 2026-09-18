import { CommerceError } from '../domain/errors.ts'
import type { AuthenticatedPrincipal } from '../auth/contracts.ts'
import { ApprovalPolicy, ApprovalPolicyError } from './policy.ts'
import { assertProposalIntegrity, ProposalRepository, type Proposal } from './repository.ts'

export class ApprovalService {
  readonly #repository: ProposalRepository
  readonly #now: () => Date
  readonly #policy: ApprovalPolicy

  constructor(options: { repository: ProposalRepository; policy?: ApprovalPolicy; now?: () => Date }) {
    this.#repository = options.repository
    this.#policy = options.policy ?? new ApprovalPolicy()
    this.#now = options.now ?? (() => new Date())
  }

  approve(input: { proposalId: string; principal: AuthenticatedPrincipal; reason: string; confirmHash: string }): Proposal {
    return this.#decide({ ...input, decision: 'APPROVED' })
  }

  reject(input: { proposalId: string; principal: AuthenticatedPrincipal; reason: string; confirmHash: string }): Proposal {
    return this.#decide({ ...input, decision: 'REJECTED' })
  }

  #decide(input: {
    proposalId: string; principal: AuthenticatedPrincipal; reason: string; confirmHash: string
    decision: 'APPROVED' | 'REJECTED'
  }): Proposal {
    if (!input.reason.trim()) throw new CommerceError('INVALID_ARGUMENT', 'Approval reason is required')
    return this.#repository.transaction(() => {
      const proposal = this.#repository.getOrThrow(input.proposalId)
      assertProposalIntegrity(proposal)
      if (proposal.status !== 'PENDING_APPROVAL') {
        throw new CommerceError('INVALID_ARGUMENT', `Proposal is not pending approval: ${proposal.status}`)
      }
      const now = this.#now().toISOString()
      let reasonCode: string
      try {
        reasonCode = this.#policy.evaluate({
          proposal, principal: input.principal, confirmHash: input.confirmHash,
          decision: input.decision, now,
        })
      } catch (error) {
        const code = error instanceof ApprovalPolicyError ? error.reasonCode : 'DENY_UNKNOWN'
        if (code === 'DENY_EXPIRED') this.#repository.transition(proposal.proposalId, 'PENDING_APPROVAL', 'EXPIRED')
        this.#repository.audit({
          proposalId: proposal.proposalId, traceId: proposal.traceId, actor: input.principal.actorId,
          eventType: 'APPROVAL_DENIED', fromStatus: 'PENDING_APPROVAL',
          toStatus: code === 'DENY_EXPIRED' ? 'EXPIRED' : undefined,
          details: { reasonCode: code }, createdAt: now,
        })
        throw error
      }
      this.#repository.insertApproval({
        approvalId: this.#repository.createApprovalId(),
        proposalId: proposal.proposalId,
        decision: input.decision,
        actor: input.principal.actorId,
        subject: input.principal.subject,
        sessionId: input.principal.sessionId,
        reason: input.reason,
        contentHash: proposal.contentHash,
        policyVersion: proposal.policyVersion,
        reasonCode,
        createdAt: now,
      })
      const next = this.#repository.transition(proposal.proposalId, 'PENDING_APPROVAL', input.decision)
      this.#repository.audit({
        proposalId: proposal.proposalId, traceId: proposal.traceId, actor: input.principal.actorId,
        eventType: input.decision === 'APPROVED' ? 'PROPOSAL_APPROVED' : 'PROPOSAL_REJECTED',
        fromStatus: 'PENDING_APPROVAL', toStatus: input.decision,
        details: { reason: input.reason, reasonCode, subject: input.principal.subject, sessionId: input.principal.sessionId },
        createdAt: now,
      })
      return next
    })
  }
}
