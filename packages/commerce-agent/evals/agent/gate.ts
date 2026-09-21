#!/usr/bin/env bun
import { readFile } from 'node:fs/promises'
import { AggregatedEvaluationSchema, ReleasePolicySchema, type AggregatedEvaluation, type ReleasePolicy } from './schemas.ts'

export type GateResult = { decision: 'PASS' | 'FAIL' | 'BLOCKED'; policyId: string; checks: Array<{ id: string; passed: boolean; actual: number | string; expected: number | string }> }

export function evaluateRelease(reportValue: unknown, policyValue: unknown): GateResult {
  const report = AggregatedEvaluationSchema.parse(reportValue)
  const policy = ReleasePolicySchema.parse(policyValue)
  const checks: GateResult['checks'] = [
    { id: 'suite', passed: report.suite === policy.suite, actual: report.suite, expected: policy.suite },
    { id: 'task-count', passed: report.taskCount === policy.requiredTaskCount, actual: report.taskCount, expected: policy.requiredTaskCount },
    { id: 'repeat-completeness', passed: report.completeRepeatTasks === policy.requiredTaskCount && report.expectedRepeats === policy.requiredRepeats, actual: `${report.completeRepeatTasks}x${report.expectedRepeats}`, expected: `${policy.requiredTaskCount}x${policy.requiredRepeats}` },
    { id: 'completion-rate', passed: report.completionRate >= policy.minimumCompletionRate, actual: report.completionRate, expected: policy.minimumCompletionRate },
    { id: 'all-repeats-success', passed: report.allRepeatsSuccessRate >= policy.minimumAllRepeatsSuccessRate, actual: report.allRepeatsSuccessRate, expected: policy.minimumAllRepeatsSuccessRate },
    { id: 'average-attempt-cost', passed: report.usage.averageAttemptCostMicros !== null && report.usage.averageAttemptCostMicros <= policy.maximumAverageAttemptCostMicros, actual: report.usage.averageAttemptCostMicros ?? 'unknown', expected: policy.maximumAverageAttemptCostMicros },
    { id: 'p95-latency', passed: report.timing.p95EndToEndMs <= policy.maximumP95EndToEndMs, actual: report.timing.p95EndToEndMs, expected: policy.maximumP95EndToEndMs },
    ...Object.entries(policy.hardMaximums).map(([id, expected]) => ({ id: `safety-${id}`, passed: report.safety[id as keyof typeof report.safety] <= expected, actual: report.safety[id as keyof typeof report.safety], expected })),
  ]
  if (report.evidenceMode !== 'live') checks.push({ id: 'live-evidence', passed: false, actual: report.evidenceMode, expected: 'live' })
  if (policy.requireKnownUsage && report.usage.unknownUsageRuns > 0) checks.push({ id: 'known-usage', passed: false, actual: report.usage.unknownUsageRuns, expected: 0 })
  if (policy.requireHumanReview) checks.push({
    id: 'human-review', passed: report.review.completedRuns === report.review.requiredRuns && report.review.rejectedRuns === 0 && report.review.discussionRuns === 0,
    actual: `${report.review.completedRuns}/${report.review.requiredRuns} completed, ${report.review.rejectedRuns} rejected, ${report.review.discussionRuns} unresolved`,
    expected: 'all required reviews accepted',
  })
  const hardFailed = checks.some(check => check.id.startsWith('safety-') && !check.passed)
  const blocked = report.evidenceMode !== 'live' || (policy.requireKnownUsage && report.usage.unknownUsageRuns > 0)
    || (policy.requireHumanReview && report.review.completedRuns !== report.review.requiredRuns)
    || (policy.requireHumanReview && report.review.discussionRuns > 0)
    || report.taskCount !== policy.requiredTaskCount || report.completeRepeatTasks !== policy.requiredTaskCount
  return { decision: hardFailed ? 'FAIL' : blocked ? 'BLOCKED' : checks.every(check => check.passed) ? 'PASS' : 'FAIL', policyId: policy.policyId, checks }
}

if (import.meta.main) {
  const reportPath = process.argv[process.argv.indexOf('--report') + 1]
  const policyPath = process.argv[process.argv.indexOf('--policy') + 1] ?? new URL('./release-policy.json', import.meta.url).pathname
  if (!reportPath) throw new Error('--report is required')
  const [report, policy] = await Promise.all([readFile(reportPath, 'utf8').then(JSON.parse), readFile(policyPath, 'utf8').then(JSON.parse)])
  const result = evaluateRelease(report, policy)
  console.log(JSON.stringify(result, null, 2))
  if (result.decision !== 'PASS') process.exitCode = 1
}
