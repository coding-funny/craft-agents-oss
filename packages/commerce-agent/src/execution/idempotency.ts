import { contentDigest, type Proposal } from '../approvals/repository.ts'

export function executionIdempotencyKey(proposal: Proposal): string {
  return contentDigest({
    proposalId: proposal.proposalId,
    actionType: proposal.actionType,
    targetId: proposal.targetId,
    version: proposal.version,
  })
}
