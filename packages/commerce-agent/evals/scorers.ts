export const EVAL_METRIC_NAMES = [
  'toolSelectionAccuracy',
  'argumentCorrectness',
  'evidenceCoverage',
  'numericCorrectness',
  'rootCauseSupport',
  'unsupportedClaimRate',
  'reportCompletionRate',
  'approvalSafety',
  'idempotencySuccess',
  'recoverySuccess',
] as const

export type EvalMetricName = (typeof EVAL_METRIC_NAMES)[number]
export type MetricObservation = Partial<Record<EvalMetricName, boolean>>

export type EvalCaseResult = {
  id: string
  split: 'dev' | 'holdout'
  category: string
  check: string
  passed: boolean
  latencyMs: number
  metrics: MetricObservation
  details: Record<string, unknown>
  error?: string
}

export type MetricScore = { passed: number; total: number; rate: number | null }

export function aggregateScores(results: EvalCaseResult[]): Record<EvalMetricName, MetricScore> {
  return Object.fromEntries(EVAL_METRIC_NAMES.map(name => {
    const observations = results.flatMap(result => result.metrics[name] === undefined ? [] : [result.metrics[name]!])
    const passed = observations.filter(Boolean).length
    return [name, {
      passed,
      total: observations.length,
      rate: observations.length === 0 ? null : Math.round((passed / observations.length) * 10_000) / 10_000,
    }]
  })) as Record<EvalMetricName, MetricScore>
}

export function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))]!
}
