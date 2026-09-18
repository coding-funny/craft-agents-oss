import type { EvidenceRecord } from '../domain/contracts.ts'
import { CommerceError } from '../domain/errors.ts'
import type { EvidenceRepository } from '../evidence/evidence-repository.ts'
import { evidenceSetHealth } from '../evidence/freshness-policy.ts'
import type { DiagnosisReport, DiagnosisReportDraft } from './schema.ts'

export type ClaimReviewVerdict = 'SUPPORTED' | 'CONTRADICTED' | 'INSUFFICIENT' | 'PENDING_REVIEW'

export type ClaimReview = {
  claimId: string
  claim: string
  evidenceIds: string[]
  verdict: ClaimReviewVerdict
  reasons: string[]
  reviewer: { kind: 'deterministic' | 'external'; version: string }
}

export type ClaimReviewRequest = {
  claimId: string
  claim: string
  evidence: EvidenceRecord[]
}

export interface SemanticReviewer {
  describe(): { kind: 'external'; version: string }
  review(input: ClaimReviewRequest, signal?: AbortSignal): Promise<{
    verdict: Exclude<ClaimReviewVerdict, 'PENDING_REVIEW'>
    reasons: string[]
  }>
}

type ReportLike = DiagnosisReport | DiagnosisReportDraft

function claims(report: ReportLike): Array<{ claimId: string; claim: string; evidenceIds: string[] }> {
  return [
    { claimId: 'executive-summary', claim: report.executiveSummary.statement, evidenceIds: report.executiveSummary.evidenceIds },
    ...report.anomalies.map((item, index) => ({
      claimId: `anomaly-${index + 1}`,
      claim: item.statement,
      evidenceIds: item.evidenceIds,
    })),
    ...report.hypotheses.map((item, index) => ({
      claimId: `hypothesis-${index + 1}`,
      claim: item.statement,
      evidenceIds: [...item.supportingEvidenceIds, ...item.counterEvidenceIds],
    })),
    ...report.recommendations.map(item => ({
      claimId: `recommendation-${item.recommendationId}`,
      claim: `${item.action}: ${item.rationale}`,
      evidenceIds: item.evidenceIds,
    })),
  ]
}

export function assertGovernedEvidenceConsistency(
  records: EvidenceRecord[],
  scope: { tenantId: string; shopId: string; currency: string },
): string {
  if (records.length === 0) throw new CommerceError('REPORT_NOT_VALIDATED', 'Claim has no evidence')
  for (const record of records) {
    if (!record.governance) throw new CommerceError('REPORT_NOT_VALIDATED', 'Evidence lacks governance metadata')
    if (record.governance.tenantId !== scope.tenantId || record.governance.shopId !== scope.shopId) {
      throw new CommerceError('SCOPE_DENIED', 'Evidence scope conflicts with report review scope')
    }
    if (record.query.currency !== scope.currency) {
      throw new CommerceError('REPORT_NOT_VALIDATED', 'Evidence currency conflicts with report review scope')
    }
  }
  const health = evidenceSetHealth(records)
  if (health.health === 'CONFLICT') {
    throw new CommerceError('REPORT_NOT_VALIDATED', 'Evidence set is internally inconsistent', { reasons: health.reasons })
  }
  return records[0]!.governance!.snapshotId
}

export async function reviewReportClaims(options: {
  report: ReportLike
  tenantId: string
  evidenceRepository: EvidenceRepository
  reviewer?: SemanticReviewer
  signal?: AbortSignal
}): Promise<{ snapshotId: string; status: 'REVIEWED' | 'PENDING_REVIEW'; reviews: ClaimReview[] }> {
  const reportClaims = claims(options.report)
  const allRecords = [...new Set(reportClaims.flatMap(claim => claim.evidenceIds))]
    .map(evidenceId => options.evidenceRepository.getOrThrowScoped(evidenceId, {
      tenantId: options.tenantId,
      shopId: options.report.scope.shopId,
    }))
  const snapshotId = assertGovernedEvidenceConsistency(allRecords, {
    tenantId: options.tenantId,
    shopId: options.report.scope.shopId,
    currency: options.report.scope.currency,
  })
  const reviews: ClaimReview[] = []
  for (const claim of reportClaims) {
    const evidence = claim.evidenceIds.map(evidenceId => options.evidenceRepository.getOrThrowScoped(evidenceId, {
      tenantId: options.tenantId,
      shopId: options.report.scope.shopId,
    }))
    if (!options.reviewer) {
      reviews.push({
        ...claim,
        verdict: 'PENDING_REVIEW',
        reasons: ['No semantic reviewer is configured; deterministic evidence consistency passed.'],
        reviewer: { kind: 'deterministic', version: 'governance-gate-v1' },
      })
      continue
    }
    try {
      options.signal?.throwIfAborted()
      const result = await options.reviewer.review({ ...claim, evidence }, options.signal)
      reviews.push({ ...claim, ...result, reviewer: options.reviewer.describe() })
    } catch (error) {
      reviews.push({
        ...claim,
        verdict: 'PENDING_REVIEW',
        reasons: [`Semantic reviewer unavailable: ${error instanceof Error ? error.message : String(error)}`],
        reviewer: options.reviewer.describe(),
      })
    }
  }
  return {
    snapshotId,
    status: reviews.some(review => review.verdict === 'PENDING_REVIEW') ? 'PENDING_REVIEW' : 'REVIEWED',
    reviews,
  }
}
