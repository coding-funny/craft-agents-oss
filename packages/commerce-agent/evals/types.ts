import { z } from 'zod'
import { DIAGNOSIS_CASES } from '../src/diagnosis/workflow.ts'

export const EvalCaseSchema = z.object({
  id: z.string().min(1),
  split: z.enum(['dev', 'holdout']),
  category: z.string().min(1),
  check: z.string().min(1),
  sourceCase: z.enum(Object.keys(DIAGNOSIS_CASES) as [keyof typeof DIAGNOSIS_CASES, ...(keyof typeof DIAGNOSIS_CASES)[]]).optional(),
  expected: z.string().min(1),
}).strict()

export type EvalCase = z.infer<typeof EvalCaseSchema>

export type EvaluationReport = {
  mode: 'deterministic-offline'
  datasetSize: number
  splitCounts: { dev: number; holdout: number }
  passed: number
  failed: number
  passRate: number
  latencyMs: { total: number; average: number; p95: number }
  scores: ReturnType<typeof import('./scorers.ts').aggregateScores>
  results: import('./scorers.ts').EvalCaseResult[]
  limitations: string[]
}
