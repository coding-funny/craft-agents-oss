#!/usr/bin/env bun
import { readFile } from 'node:fs/promises'
import { AggregatedEvaluationSchema, type AggregatedEvaluation } from './schemas.ts'

export function compareEvaluations(baseValue: unknown, candidateValue: unknown) {
  const base = AggregatedEvaluationSchema.parse(baseValue)
  const candidate = AggregatedEvaluationSchema.parse(candidateValue)
  for (const field of ['suite', 'datasetDigest', 'taskCount', 'expectedRepeats', 'evidenceMode'] as const) {
    if (base[field] !== candidate[field]) throw new Error(`Evaluation reports are not comparable: ${field} differs`)
  }
  const delta = (select: (report: AggregatedEvaluation) => number | null) => {
    const left = select(base); const right = select(candidate)
    return left === null || right === null ? null : right - left
  }
  return {
    base: { evaluationId: base.evaluationId, variant: base.variant },
    candidate: { evaluationId: candidate.evaluationId, variant: candidate.variant },
    deltas: {
      completionRate: delta(report => report.completionRate),
      allRepeatsSuccessRate: delta(report => report.allRepeatsSuccessRate),
      gradeRate: delta(report => report.grade.rate),
      averageAttemptCostMicros: delta(report => report.usage.averageAttemptCostMicros),
      p95EndToEndMs: delta(report => report.timing.p95EndToEndMs),
    },
  }
}

if (import.meta.main) {
  const basePath = process.argv[process.argv.indexOf('--base') + 1]
  const candidatePath = process.argv[process.argv.indexOf('--candidate') + 1]
  if (!basePath || !candidatePath) throw new Error('--base and --candidate are required')
  console.log(JSON.stringify(compareEvaluations(
    JSON.parse(await readFile(basePath, 'utf8')), JSON.parse(await readFile(candidatePath, 'utf8')),
  ), null, 2))
}
