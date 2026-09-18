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
