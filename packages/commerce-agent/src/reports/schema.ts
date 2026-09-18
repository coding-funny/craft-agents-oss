import { z } from 'zod'
import { CurrencySchema, IdentifierSchema, IsoDateTimeSchema, TimeRangeSchema } from '../domain/contracts.ts'

export const EvidenceIdSchema = z.string().regex(/^ev_[a-f0-9]{24}$/)
export const ReportIdSchema = z.string().regex(/^report_[a-f0-9]{24}$/)
export const ConfidenceLevelSchema = z.enum(['LOW', 'MEDIUM', 'HIGH'])

export const ReportScopeSchema = z.object({
  shopId: IdentifierSchema,
  skuIds: z.array(IdentifierSchema).min(1).max(100),
  baselineWindow: TimeRangeSchema,
  currentWindow: TimeRangeSchema,
  currency: CurrencySchema,
}).strict()

const MetricSnapshotSchema = z.object({
  value: z.number().nullable(),
  unit: z.string().min(1),
  evidenceIds: z.array(EvidenceIdSchema).min(1),
}).strict()

export const KpiComparisonSchema = z.object({
  name: IdentifierSchema,
  baseline: MetricSnapshotSchema,
  current: MetricSnapshotSchema,
  changeRate: z.number().nullable(),
}).strict()

export const ReportFactSchema = z.object({
  kind: z.literal('FACT'),
  statement: z.string().min(1),
  evidenceIds: z.array(EvidenceIdSchema).min(1),
}).strict()

export const ReportHypothesisSchema = z.object({
  kind: z.literal('HYPOTHESIS'),
  statement: z.string().min(1),
  confidence: ConfidenceLevelSchema,
  confidenceScore: z.number().min(0).max(1),
  supportingEvidenceIds: z.array(EvidenceIdSchema).min(1),
  counterEvidenceIds: z.array(EvidenceIdSchema),
  limitations: z.array(z.string().min(1)),
}).strict()

export const ActionTypeSchema = z.enum([
  'ADJUST_AD_BUDGET',
  'PAUSE_AD_CAMPAIGN',
  'CREATE_REPLENISHMENT_TASK',
  'CREATE_PROMOTION_TICKET',
])

export const ActionDraftSchema = z.object({
  actionType: ActionTypeSchema,
  targetId: IdentifierSchema,
  parameters: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  preconditions: z.array(z.string().min(1)).min(1),
  expectedImpact: z.string().min(1),
  rollbackPlan: z.string().min(1),
}).strict().superRefine((draft, context) => {
  const integer = (name: string, minimum: number) => {
    const value = draft.parameters[name]
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
      context.addIssue({
        code: 'custom',
        path: ['parameters', name],
        message: `${draft.actionType} requires ${name} to be a safe integer >= ${minimum}`,
      })
    }
  }

  if (draft.actionType === 'ADJUST_AD_BUDGET') {
    integer('newBudgetMinor', 0)
    integer('expectedVersion', 1)
    if (!CurrencySchema.safeParse(draft.parameters.currency).success) {
      context.addIssue({
        code: 'custom',
        path: ['parameters', 'currency'],
        message: 'ADJUST_AD_BUDGET requires a supported currency',
      })
    }
  } else if (draft.actionType === 'PAUSE_AD_CAMPAIGN') {
    integer('expectedVersion', 1)
  } else if (draft.actionType === 'CREATE_REPLENISHMENT_TASK') {
    integer('requestedQty', 1)
  } else {
    const floor = draft.parameters.contributionRateFloor
    const reviewOnly = draft.parameters.evidenceReviewOnly
    if (!(typeof floor === 'number' && floor >= 0 && floor <= 1) && reviewOnly !== true) {
      context.addIssue({
        code: 'custom',
        path: ['parameters'],
        message: 'CREATE_PROMOTION_TICKET requires contributionRateFloor in [0, 1] or evidenceReviewOnly=true',
      })
    }
  }
})

export const ReportRecommendationSchema = z.object({
  recommendationId: IdentifierSchema,
  kind: z.literal('RECOMMENDATION'),
  action: z.string().min(1),
  rationale: z.string().min(1),
  riskLevel: z.enum(['LOW', 'MEDIUM', 'HIGH']),
  evidenceIds: z.array(EvidenceIdSchema).min(1),
  proposalDraft: z.string().min(1).optional(),
  actionDraft: ActionDraftSchema,
}).strict().superRefine((recommendation, context) => {
  if (recommendation.riskLevel === 'HIGH' && !recommendation.proposalDraft) {
    context.addIssue({ code: 'custom', path: ['proposalDraft'], message: 'High-risk recommendations require a proposal draft' })
  }
})

export const ReportEvidenceSchema = z.object({
  evidenceId: EvidenceIdSchema,
  source: z.string().min(1),
  asOf: IsoDateTimeSchema,
  summary: z.string().min(1),
}).strict()

export const DiagnosisReportDraftSchema = z.object({
  traceId: IdentifierSchema,
  caseId: IdentifierSchema,
  generatedAt: IsoDateTimeSchema,
  status: z.enum(['RESOLVED', 'NEEDS_DATA', 'UNRESOLVED']),
  scope: ReportScopeSchema,
  executiveSummary: z.object({
    statement: z.string().min(1),
    evidenceIds: z.array(EvidenceIdSchema).min(1),
  }).strict(),
  kpis: z.array(KpiComparisonSchema).min(1),
  anomalies: z.array(ReportFactSchema).min(1),
  hypotheses: z.array(ReportHypothesisSchema).min(1),
  evidence: z.array(ReportEvidenceSchema).min(1),
  risks: z.array(z.string().min(1)),
  unknowns: z.array(z.object({
    statement: z.string().min(1),
    requiredData: z.string().min(1),
  }).strict()),
  recommendations: z.array(ReportRecommendationSchema),
}).strict().superRefine((report, context) => {
  if (report.status === 'NEEDS_DATA' && report.unknowns.length === 0) {
    context.addIssue({ code: 'custom', path: ['unknowns'], message: 'NEEDS_DATA reports must describe missing data' })
  }
})

export const DiagnosisReportSchema = DiagnosisReportDraftSchema.extend({
  reportId: ReportIdSchema,
}).strict()

export type ReportScope = z.infer<typeof ReportScopeSchema>
export type KpiComparison = z.infer<typeof KpiComparisonSchema>
export type ReportFact = z.infer<typeof ReportFactSchema>
export type ReportHypothesis = z.infer<typeof ReportHypothesisSchema>
export type ReportRecommendation = z.infer<typeof ReportRecommendationSchema>
export type ActionType = z.infer<typeof ActionTypeSchema>
export type ActionDraft = z.infer<typeof ActionDraftSchema>
export type DiagnosisReportDraft = z.infer<typeof DiagnosisReportDraftSchema>
export type DiagnosisReport = z.infer<typeof DiagnosisReportSchema>
