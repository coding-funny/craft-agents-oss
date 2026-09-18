import { AggregatedEvaluationSchema, RunEvidenceSchema, type AggregatedEvaluation, type RunEvidence } from './schemas.ts'

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)]!
}

function same<T>(runs: RunEvidence[], select: (run: RunEvidence) => T, label: string): T {
  const values = [...new Set(runs.map(run => JSON.stringify(select(run))))]
  if (values.length !== 1) throw new Error(`Run evidence mixes ${label}`)
  return select(runs[0]!)
}

export function aggregateRunEvidence(values: unknown[], expectedRepeats: number): AggregatedEvaluation {
  if (values.length === 0) throw new Error('Run evidence is empty')
  const runs = values.map(value => RunEvidenceSchema.parse(value))
  if (new Set(runs.map(run => run.runId)).size !== runs.length) throw new Error('Run evidence contains duplicate runId values')
  if (new Set(runs.map(run => `${run.caseId}:${run.repeat}`)).size !== runs.length) throw new Error('Run evidence contains duplicate case/repeat values')
  for (const [label, select] of [
    ['evaluationId', (run: RunEvidence) => run.evaluationId], ['suite', (run: RunEvidence) => run.suite],
    ['variant', (run: RunEvidence) => run.variant], ['evidenceMode', (run: RunEvidence) => run.evidenceMode],
    ['datasetDigest', (run: RunEvidence) => run.datasetDigest], ['configDigest', (run: RunEvidence) => run.configDigest],
    ['promptVersion', (run: RunEvidence) => run.promptVersion], ['toolVersion', (run: RunEvidence) => run.toolVersion],
  ] as const) same(runs, select, label)
  const byCase = new Map<string, RunEvidence[]>()
  for (const run of runs) byCase.set(run.caseId, [...(byCase.get(run.caseId) ?? []), run])
  const caseRuns = [...byCase.values()]
  const complete = caseRuns.filter(items => items.length === expectedRepeats)
  const knownCosts = runs.flatMap(run => run.usage.costMicros === undefined ? [] : [run.usage.costMicros])
  const successCosts = runs.flatMap(run => run.grade.passed && run.usage.costMicros !== undefined ? [run.usage.costMicros] : [])
  const failureCounts: Record<string, number> = {}
  for (const failure of runs.flatMap(run => run.grade.failures)) failureCounts[failure] = (failureCounts[failure] ?? 0) + 1
  const sum = (select: (run: RunEvidence) => number) => runs.reduce((total, run) => total + select(run), 0)
  return AggregatedEvaluationSchema.parse({
    schemaVersion: 1,
    evaluationId: same(runs, run => run.evaluationId, 'evaluationId'), suite: same(runs, run => run.suite, 'suite'),
    variant: same(runs, run => run.variant, 'variant'), evidenceMode: same(runs, run => run.evidenceMode, 'evidenceMode'),
    datasetDigest: same(runs, run => run.datasetDigest, 'datasetDigest'), configDigest: same(runs, run => run.configDigest, 'configDigest'),
    promptVersion: same(runs, run => run.promptVersion, 'promptVersion'), toolVersion: same(runs, run => run.toolVersion, 'toolVersion'),
    taskCount: byCase.size, runCount: runs.length, expectedRepeats, completeRepeatTasks: complete.length,
    anySuccessTasks: caseRuns.filter(items => items.some(run => run.grade.passed)).length,
    allRepeatsSuccessTasks: complete.filter(items => items.every(run => run.grade.passed)).length,
    completionRate: caseRuns.filter(items => items.some(run => run.grade.passed)).length / byCase.size,
    allRepeatsSuccessRate: complete.length === 0 ? 0 : complete.filter(items => items.every(run => run.grade.passed)).length / complete.length,
    grade: { earned: sum(run => run.grade.earned), possible: sum(run => run.grade.possible), rate: sum(run => run.grade.earned) / sum(run => run.grade.possible) },
    usage: {
      knownCostMicros: knownCosts.reduce((a, b) => a + b, 0),
      unknownUsageRuns: runs.filter(run => run.usage.source === 'unknown').length,
      averageAttemptCostMicros: knownCosts.length ? knownCosts.reduce((a, b) => a + b, 0) / knownCosts.length : null,
      averageSuccessCostMicros: successCosts.length ? successCosts.reduce((a, b) => a + b, 0) / successCosts.length : null,
    },
    timing: {
      p50EndToEndMs: percentile(runs.map(run => run.timing.endToEndMs), 0.5),
      p95EndToEndMs: percentile(runs.map(run => run.timing.endToEndMs), 0.95),
      averageQueueMs: sum(run => run.timing.queueMs) / runs.length,
    },
    runtime: {
      totalToolCalls: sum(run => run.runtime.toolCalls), totalReportRepairs: sum(run => run.runtime.reportRepairs),
      totalLookupAttempts: sum(run => run.runtime.lookupAttempts), manualReviewRuns: runs.filter(run => run.runtime.manualReview).length,
    },
    review: {
      requiredRuns: runs.filter(run => run.suite === 'holdout' || run.review.highRisk || run.review.graderDisagreement).length,
      completedRuns: runs.filter(run => (run.suite === 'holdout' || run.review.highRisk || run.review.graderDisagreement) && run.review.human !== undefined).length,
      rejectedRuns: runs.filter(run => run.review.human?.decision === 'REJECT').length,
      discussionRuns: runs.filter(run => run.review.human?.decision === 'NEEDS_DISCUSSION').length,
    },
    safety: {
      scopeViolations: sum(run => run.safety.scopeViolations), unapprovedExecutions: sum(run => run.safety.unapprovedExecutions),
      duplicateEffects: sum(run => run.safety.duplicateEffects), unexplainedHanging: sum(run => run.safety.unexplainedHanging),
    },
    failureCounts,
  })
}
