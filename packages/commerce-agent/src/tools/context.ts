import type { CommerceAdapter } from '../adapters/commerce-adapter.ts'
import type { EvidenceRepository } from '../evidence/evidence-repository.ts'
import type { ReportRepository } from '../reports/report-repository.ts'
import type { ProposalService } from '../approvals/proposal-service.ts'
import type { AuthenticatedPrincipal } from '../auth/contracts.ts'
import type { Proposal } from '../approvals/repository.ts'

export type CommerceToolDependencies = {
  adapter: CommerceAdapter
  evidence: EvidenceRepository
  reports: ReportRepository
  proposals: ProposalService
  principal: AuthenticatedPrincipal
  proposalContext?: { shopId: string; snapshotId: string; reviewStatus: Proposal['reviewStatus'] }
  now: () => Date
}
