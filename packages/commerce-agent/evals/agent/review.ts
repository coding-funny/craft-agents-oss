import { RunEvidenceSchema, type RunEvidence } from './schemas.ts'

export type ReviewItem = {
  caseId: string; runId: string; reasons: string[]; status: 'PENDING'; reviewer?: string; reviewedAt?: string
}

export function buildReviewQueue(values: unknown[]): ReviewItem[] {
  return values.map(value => RunEvidenceSchema.parse(value)).flatMap((run: RunEvidence) => {
    if (run.review.human) return []
    const reasons = [
      ...(run.suite === 'holdout' ? ['HOLDOUT_KEY_CONCLUSION'] : []),
      ...(run.review.highRisk ? ['HIGH_RISK'] : []),
      ...(run.review.graderDisagreement ? ['GRADER_DISAGREEMENT'] : []),
      ...(!run.grade.passed ? ['FAILED_GRADE'] : []),
      ...(run.runtime.manualReview ? ['RUNTIME_MANUAL_REVIEW'] : []),
    ]
    return reasons.length ? [{ caseId: run.caseId, runId: run.runId, reasons: [...new Set(reasons)], status: 'PENDING' as const }] : []
  })
}
