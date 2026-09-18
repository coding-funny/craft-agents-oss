import type { CommerceAdapter } from '../adapters/commerce-adapter.ts'
import type { EvidenceRepository } from '../evidence/evidence-repository.ts'
import type { ReportRepository } from '../reports/report-repository.ts'
import type { ProposalService } from '../approvals/proposal-service.ts'

export type CommerceToolDependencies = {
  adapter: CommerceAdapter
  evidence: EvidenceRepository
  reports: ReportRepository
  proposals: ProposalService
  now: () => Date
}
