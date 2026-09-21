import { z } from 'zod'
import { InvestigationInputSchema } from '../../src/contracts/task.ts'

export const AgentEvalCategorySchema = z.enum(['normal', 'ads', 'commerce', 'uncertain', 'failure'])

export const AgentEvalCaseSchema = z.object({
  id: z.string().regex(/^(normal|ads|commerce|uncertain|failure)-\d{2}$/),
  category: AgentEvalCategorySchema,
  input: InvestigationInputSchema,
  fixtureVariant: z.string().min(1),
}).strict()

export const AgentEvalGoldSchema = z.object({
  id: z.string().min(1),
  expectedStatuses: z.array(z.enum(['WAITING_INPUT', 'REPORT_READY', 'FAILED'])).min(1),
  requiredEvidenceTools: z.array(z.enum(['query_sales', 'query_inventory', 'query_promotions', 'compute_margin', 'query_ads'])),
  requiredUnknowns: z.array(z.string()),
  forbiddenClaims: z.array(z.string()),
}).strict()

export const AgentEvalPredictionSchema = z.object({
  id: z.string().min(1),
  status: z.enum(['WAITING_INPUT', 'REPORT_READY', 'FAILED', 'CANCELLED', 'TIMED_OUT']),
  evidenceTools: z.array(z.string()).default([]),
  unknowns: z.array(z.string()).default([]),
  claims: z.array(z.string()).default([]),
  modelMode: z.enum(['fake', 'live']),
}).strict()

export type AgentEvalCase = z.infer<typeof AgentEvalCaseSchema>
export type AgentEvalGold = z.infer<typeof AgentEvalGoldSchema>
export type AgentEvalPrediction = z.infer<typeof AgentEvalPredictionSchema>

export const EvaluationVariantSchema = z.enum(['rules', 'single_turn', 'multi_step_agent'])
export const EvidenceModeSchema = z.enum(['deterministic', 'fake', 'live'])

export const RunUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  costMicros: z.number().int().nonnegative().optional(),
  source: z.enum(['actual', 'estimated', 'unknown']),
}).strict().superRefine((usage, context) => {
  if (usage.source !== 'unknown' && usage.costMicros === undefined) {
    context.addIssue({ code: 'custom', path: ['costMicros'], message: 'known usage requires costMicros' })
  }
  if (usage.source === 'unknown' && usage.costMicros !== undefined) {
    context.addIssue({ code: 'custom', path: ['costMicros'], message: 'unknown usage must not be encoded as a known cost' })
  }
})

export const RunEvidenceSchema = z.object({
  schemaVersion: z.literal(1),
  evaluationId: z.string().min(1),
  suite: z.enum(['dev', 'holdout']),
  caseId: z.string().min(1),
  repeat: z.number().int().min(1),
  runId: z.string().min(1),
  variant: EvaluationVariantSchema,
  evidenceMode: EvidenceModeSchema,
  model: z.object({ provider: z.string().min(1), modelId: z.string().min(1), modelVersion: z.string().min(1).optional() }).strict().optional(),
  datasetDigest: z.string().regex(/^[a-f0-9]{64}$/),
  configDigest: z.string().regex(/^[a-f0-9]{64}$/),
  promptVersion: z.string().min(1),
  toolVersion: z.string().min(1),
  status: z.enum(['WAITING_INPUT', 'REPORT_READY', 'FAILED', 'CANCELLED', 'TIMED_OUT']),
  grade: z.object({
    passed: z.boolean(), score: z.number().min(0).max(1), earned: z.number().int().nonnegative(),
    possible: z.number().int().positive(), failures: z.array(z.string()),
  }).strict(),
  usage: RunUsageSchema,
  timing: z.object({ queueMs: z.number().nonnegative(), runMs: z.number().nonnegative(), endToEndMs: z.number().nonnegative() }).strict(),
  runtime: z.object({
    toolCalls: z.number().int().nonnegative(), reportRepairs: z.number().int().nonnegative(),
    lookupAttempts: z.number().int().nonnegative(), recoveryLatencyMs: z.number().nonnegative().optional(),
    unknownAgeMs: z.number().nonnegative().optional(), manualReview: z.boolean(),
  }).strict(),
  safety: z.object({
    scopeViolations: z.number().int().nonnegative(), unapprovedExecutions: z.number().int().nonnegative(),
    duplicateEffects: z.number().int().nonnegative(), unexplainedHanging: z.number().int().nonnegative(),
  }).strict(),
  review: z.object({
    highRisk: z.boolean(), graderDisagreement: z.boolean(),
    human: z.object({
      reviewer: z.string().min(1), reviewedAt: z.string().datetime({ offset: true }),
      decision: z.enum(['ACCEPT', 'REJECT', 'NEEDS_DISCUSSION']), notes: z.string().min(1),
    }).strict().optional(),
  }).strict(),
}).strict().superRefine((run, context) => {
  if (run.evidenceMode === 'live' && !run.model) context.addIssue({ code: 'custom', path: ['model'], message: 'live evidence requires model identity' })
  if (run.variant !== 'rules' && !run.model) context.addIssue({ code: 'custom', path: ['model'], message: 'model variants require model identity' })
  if (run.grade.earned > run.grade.possible) context.addIssue({ code: 'custom', path: ['grade', 'earned'], message: 'earned grade cannot exceed possible grade' })
  const expectedScore = run.grade.earned / run.grade.possible
  if (Math.abs(run.grade.score - expectedScore) > Number.EPSILON) context.addIssue({ code: 'custom', path: ['grade', 'score'], message: 'grade score must equal earned / possible' })
  if (run.grade.passed !== (run.grade.earned === run.grade.possible)) context.addIssue({ code: 'custom', path: ['grade', 'passed'], message: 'grade passed must mean full credit' })
  if (run.timing.endToEndMs < run.timing.queueMs || run.timing.endToEndMs < run.timing.runMs) context.addIssue({ code: 'custom', path: ['timing', 'endToEndMs'], message: 'end-to-end timing cannot be shorter than queue or run timing' })
})

export const ReleasePolicySchema = z.object({
  schemaVersion: z.literal(1),
  policyId: z.string().min(1),
  suite: z.literal('holdout'),
  requiredTaskCount: z.number().int().positive(),
  requiredRepeats: z.number().int().min(1),
  minimumCompletionRate: z.number().min(0).max(1),
  minimumAllRepeatsSuccessRate: z.number().min(0).max(1),
  maximumAverageAttemptCostMicros: z.number().int().positive(),
  maximumP95EndToEndMs: z.number().positive(),
  requireKnownUsage: z.boolean(),
  requireHumanReview: z.boolean(),
  hardMaximums: z.object({
    scopeViolations: z.literal(0), unapprovedExecutions: z.literal(0),
    duplicateEffects: z.literal(0), unexplainedHanging: z.literal(0),
  }).strict(),
}).strict()

export const AggregatedEvaluationSchema = z.object({
  schemaVersion: z.literal(1), evaluationId: z.string(), suite: z.enum(['dev', 'holdout']),
  variant: EvaluationVariantSchema, evidenceMode: EvidenceModeSchema,
  datasetDigest: z.string(), configDigest: z.string(), promptVersion: z.string(), toolVersion: z.string(),
  taskCount: z.number().int().nonnegative(), runCount: z.number().int().nonnegative(),
  expectedRepeats: z.number().int().positive(), completeRepeatTasks: z.number().int().nonnegative(),
  anySuccessTasks: z.number().int().nonnegative(), allRepeatsSuccessTasks: z.number().int().nonnegative(),
  completionRate: z.number().min(0).max(1), allRepeatsSuccessRate: z.number().min(0).max(1),
  grade: z.object({ earned: z.number(), possible: z.number(), rate: z.number().min(0).max(1) }).strict(),
  usage: z.object({
    knownCostMicros: z.number().int().nonnegative(), unknownUsageRuns: z.number().int().nonnegative(),
    averageAttemptCostMicros: z.number().nonnegative().nullable(), averageSuccessCostMicros: z.number().nonnegative().nullable(),
  }).strict(),
  timing: z.object({ p50EndToEndMs: z.number().nonnegative(), p95EndToEndMs: z.number().nonnegative(), averageQueueMs: z.number().nonnegative() }).strict(),
  runtime: z.object({ totalToolCalls: z.number().int().nonnegative(), totalReportRepairs: z.number().int().nonnegative(), totalLookupAttempts: z.number().int().nonnegative(), manualReviewRuns: z.number().int().nonnegative() }).strict(),
  review: z.object({
    requiredRuns: z.number().int().nonnegative(), completedRuns: z.number().int().nonnegative(),
    rejectedRuns: z.number().int().nonnegative(), discussionRuns: z.number().int().nonnegative(),
  }).strict(),
  safety: z.object({ scopeViolations: z.number().int().nonnegative(), unapprovedExecutions: z.number().int().nonnegative(), duplicateEffects: z.number().int().nonnegative(), unexplainedHanging: z.number().int().nonnegative() }).strict(),
  failureCounts: z.record(z.string(), z.number().int().nonnegative()),
}).strict()

export type RunEvidence = z.infer<typeof RunEvidenceSchema>
export type ReleasePolicy = z.infer<typeof ReleasePolicySchema>
export type AggregatedEvaluation = z.infer<typeof AggregatedEvaluationSchema>
