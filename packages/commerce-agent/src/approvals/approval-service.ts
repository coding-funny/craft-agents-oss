import { CommerceError } from '../domain/errors.ts'
import { assertProposalIntegrity, ProposalRepository, type Proposal } from './repository.ts'

export class ApprovalService {
  readonly #repository: ProposalRepository
  readonly #now: () => Date

  constructor(options: { repository: ProposalRepository; now?: () => Date }) {
    this.#repository = options.repository
    this.#now = options.now ?? (() => new Date())
  }

  approve(input: { proposalId: string; actor: string; reason: string }): Proposal {
    return this.#decide({ ...input, decision: 'APPROVED' })
  }

  reject(input: { proposalId: string; actor: string; reason: string }): Proposal {
    return this.#decide({ ...input, decision: 'REJECTED' })
  }

  #decide(input: { proposalId: string; actor: string; reason: string; decision: 'APPROVED' | 'REJECTED' }): Proposal {
    if (!input.actor.trim() || !input.reason.trim()) throw new CommerceError('INVALID_ARGUMENT', 'Approval actor and reason are required')
    const outcome = this.#repository.transaction<{ proposal?: Proposal; expired: boolean }>(() => {
      const proposal = this.#repository.getOrThrow(input.proposalId)
      assertProposalIntegrity(proposal)
      if (proposal.status !== 'PENDING_APPROVAL') {
        throw new CommerceError('INVALID_ARGUMENT', `Proposal is not pending approval: ${proposal.status}`)
      }
      const now = this.#now().toISOString()
      if (Date.parse(proposal.expiresAt) <= Date.parse(now)) {
        this.#repository.transition(proposal.proposalId, 'PENDING_APPROVAL', 'EXPIRED')
        this.#repository.audit({
          proposalId: proposal.proposalId, traceId: proposal.traceId, actor: input.actor,
          eventType: 'PROPOSAL_EXPIRED', fromStatus: 'PENDING_APPROVAL', toStatus: 'EXPIRED', createdAt: now,
        })
        return { expired: true }
      }
      this.#repository.insertApproval({
        approvalId: this.#repository.createApprovalId(),
        proposalId: proposal.proposalId,
        decision: input.decision,
        actor: input.actor,
        reason: input.reason,
        contentHash: proposal.contentHash,
        createdAt: now,
      })
      const next = this.#repository.transition(proposal.proposalId, 'PENDING_APPROVAL', input.decision)
      this.#repository.audit({
        proposalId: proposal.proposalId, traceId: proposal.traceId, actor: input.actor,
        eventType: input.decision === 'APPROVED' ? 'PROPOSAL_APPROVED' : 'PROPOSAL_REJECTED',
        fromStatus: 'PENDING_APPROVAL', toStatus: input.decision, details: { reason: input.reason }, createdAt: now,
      })
      return { proposal: next, expired: false }
    })
    if (outcome.expired) throw new CommerceError('INVALID_ARGUMENT', 'Proposal has expired')
    return outcome.proposal!
  }
}
