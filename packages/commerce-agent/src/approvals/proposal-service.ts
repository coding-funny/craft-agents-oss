import { CommerceError } from '../domain/errors.ts'
import type { ReportRepository } from '../reports/report-repository.ts'
import { contentDigest, type Proposal, type ProposalContent, ProposalRepository } from './repository.ts'

export class ProposalService {
  readonly #reports: ReportRepository
  readonly #repository: ProposalRepository
  readonly #now: () => Date

  constructor(options: { reports: ReportRepository; repository: ProposalRepository; now?: () => Date }) {
    this.#reports = options.reports
    this.#repository = options.repository
    this.#now = options.now ?? (() => new Date())
  }

  async create(input: { reportId: string; recommendationId: string; expiresAt: string }): Promise<Proposal> {
    const existing = this.#repository.findByReportRecommendation(input.reportId, input.recommendationId)
    if (existing) return existing
    const report = await this.#reports.get(input.reportId)
    if (report.status !== 'RESOLVED') {
      throw new CommerceError('INVALID_ARGUMENT', `Only RESOLVED reports can create proposals: ${report.status}`)
    }
    const recommendation = report.recommendations.find(item => item.recommendationId === input.recommendationId)
    if (!recommendation) throw new CommerceError('NOT_FOUND', `Recommendation not found: ${input.recommendationId}`)
    const now = this.#now().toISOString()
    if (Date.parse(input.expiresAt) <= Date.parse(now)) throw new CommerceError('INVALID_ARGUMENT', 'Proposal expiry must be in the future')
    const content: ProposalContent = {
      reportId: report.reportId,
      recommendationId: recommendation.recommendationId,
      traceId: report.traceId,
      evidenceIds: [...new Set(recommendation.evidenceIds)].sort(),
      actionType: recommendation.actionDraft.actionType,
      targetId: recommendation.actionDraft.targetId,
      parameters: recommendation.actionDraft.parameters,
      riskLevel: recommendation.riskLevel,
      expectedImpact: recommendation.actionDraft.expectedImpact,
      rollbackPlan: recommendation.actionDraft.rollbackPlan,
      createdAt: now,
      expiresAt: input.expiresAt,
      version: 1,
    }
    const contentHash = contentDigest(content)
    const proposalId = `proposal_${contentHash.slice(0, 24)}`
    const idempotencyKey = contentDigest({ proposalId, actionType: content.actionType, targetId: content.targetId, version: content.version })
    return this.#repository.transaction(() => {
      const repeated = this.#repository.findByReportRecommendation(input.reportId, input.recommendationId)
      if (repeated) return repeated
      const draft: Proposal = { ...content, proposalId, contentHash, idempotencyKey, status: 'DRAFT' }
      this.#repository.insert(draft)
      this.#repository.audit({ proposalId, traceId: report.traceId, actor: 'agent', eventType: 'PROPOSAL_CREATED', toStatus: 'DRAFT', createdAt: now })
      const pending = this.#repository.transition(proposalId, 'DRAFT', 'PENDING_APPROVAL')
      this.#repository.audit({
        proposalId, traceId: report.traceId, actor: 'agent', eventType: 'SUBMITTED_FOR_APPROVAL',
        fromStatus: 'DRAFT', toStatus: 'PENDING_APPROVAL', createdAt: now,
      })
      return pending
    })
  }

  get(proposalId: string): Proposal {
    return this.#repository.getOrThrow(proposalId)
  }
}
