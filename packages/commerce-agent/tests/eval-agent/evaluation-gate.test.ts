import { describe, expect, it } from 'bun:test'
import { aggregateRunEvidence } from '../../evals/agent/aggregate.ts'
import { compareEvaluations } from '../../evals/agent/compare.ts'
import { evaluateRelease } from '../../evals/agent/gate.ts'
import { buildReviewQueue } from '../../evals/agent/review.ts'
import { ReleasePolicySchema, RunEvidenceSchema, type RunEvidence } from '../../evals/agent/schemas.ts'
import policyJson from '../../evals/agent/release-policy.json'

const HASH = 'a'.repeat(64)
const POLICY = ReleasePolicySchema.parse(policyJson)

function run(caseId: string, repeat: number, options: {
  passed?: boolean; mode?: RunEvidence['evidenceMode']; unknownUsage?: boolean
  safety?: Partial<RunEvidence['safety']>; configDigest?: string; runId?: string
  highRisk?: boolean; disagreement?: boolean; manualReview?: boolean
  humanReviewed?: boolean
  humanDecision?: 'ACCEPT' | 'REJECT' | 'NEEDS_DISCUSSION'
} = {}): RunEvidence {
  const passed = options.passed ?? true
  return RunEvidenceSchema.parse({
    schemaVersion: 1, evaluationId: 'eval-1', suite: 'holdout', caseId, repeat,
    runId: options.runId ?? `${caseId}-run-${repeat}`, variant: 'multi_step_agent',
    evidenceMode: options.mode ?? 'live', model: { provider: 'test', modelId: 'model-1', modelVersion: 'fixed-1' },
    datasetDigest: HASH, configDigest: options.configDigest ?? HASH, promptVersion: 'prompt-v1', toolVersion: 'tools-v1',
    status: passed ? 'REPORT_READY' : 'FAILED',
    grade: { passed, score: passed ? 1 : 0.5, earned: passed ? 4 : 2, possible: 4, failures: passed ? [] : ['unsupported-claim'] },
    usage: options.unknownUsage
      ? { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, source: 'unknown' }
      : { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, costMicros: 100_000, source: 'actual' },
    timing: { queueMs: 10 * repeat, runMs: 100, endToEndMs: 100 * repeat },
    runtime: { toolCalls: 2, reportRepairs: 0, lookupAttempts: 0, manualReview: options.manualReview ?? false },
    safety: { scopeViolations: 0, unapprovedExecutions: 0, duplicateEffects: 0, unexplainedHanging: 0, ...options.safety },
    review: {
      highRisk: options.highRisk ?? false, graderDisagreement: options.disagreement ?? false,
      human: options.humanReviewed ? { reviewer: 'reviewer-1', reviewedAt: '2026-09-18T10:00:00+08:00', decision: options.humanDecision ?? 'ACCEPT', notes: 'Evidence checked.' } : undefined,
    },
  })
}

describe('evaluation aggregation and release gate', () => {
  it('aggregates repeats by business task and keeps success/all-repeat rates distinct', () => {
    const report = aggregateRunEvidence([
      run('case-a', 1), run('case-a', 2), run('case-a', 3),
      run('case-b', 1), run('case-b', 2, { passed: false }), run('case-b', 3),
    ], 3)
    expect(report.taskCount).toBe(2)
    expect(report.runCount).toBe(6)
    expect(report.completionRate).toBe(1)
    expect(report.allRepeatsSuccessRate).toBe(0.5)
    expect(report.usage.knownCostMicros).toBe(600_000)
    expect(report.timing.p95EndToEndMs).toBe(300)
  })

  it('rejects duplicate runs, duplicate repeats, and mixed configurations', () => {
    expect(() => aggregateRunEvidence([run('case-a', 1), run('case-b', 1, { runId: 'case-a-run-1' })], 1)).toThrow('duplicate runId')
    expect(() => aggregateRunEvidence([run('case-a', 1), run('case-a', 1, { runId: 'other' })], 1)).toThrow('duplicate case/repeat')
    expect(() => aggregateRunEvidence([run('case-a', 1), run('case-b', 1, { configDigest: 'b'.repeat(64) })], 1)).toThrow('configDigest')
  })

  it('never passes fake, incomplete, unknown-cost, or unsafe release evidence', () => {
    const fake = aggregateRunEvidence([run('case-a', 1, { mode: 'fake' })], 1)
    expect(evaluateRelease(fake, { ...POLICY, requiredTaskCount: 1, requiredRepeats: 1 }).decision).toBe('BLOCKED')

    const unknown = aggregateRunEvidence([run('case-a', 1, { unknownUsage: true })], 1)
    expect(evaluateRelease(unknown, { ...POLICY, requiredTaskCount: 1, requiredRepeats: 1 }).decision).toBe('BLOCKED')

    const unsafe = aggregateRunEvidence([run('case-a', 1, { safety: { duplicateEffects: 1 } })], 1)
    expect(evaluateRelease(unsafe, { ...POLICY, requiredTaskCount: 1, requiredRepeats: 1 }).decision).toBe('FAIL')

    const unreviewed = aggregateRunEvidence([run('case-a', 1)], 1)
    expect(evaluateRelease(unreviewed, { ...POLICY, requiredTaskCount: 1, requiredRepeats: 1 }).decision).toBe('BLOCKED')
  })

  it('passes only complete live evidence that satisfies locked thresholds', () => {
    const report = aggregateRunEvidence([
      run('case-a', 1, { humanReviewed: true }), run('case-a', 2, { humanReviewed: true }), run('case-a', 3, { humanReviewed: true }),
    ], 3)
    const result = evaluateRelease(report, { ...POLICY, requiredTaskCount: 1 })
    expect(result.decision).toBe('PASS')
    expect(result.checks.every(check => check.passed)).toBe(true)
  })

  it('blocks unresolved human-review discussion and inconsistent grades', () => {
    const unresolved = aggregateRunEvidence([run('case-a', 1, { humanReviewed: true, humanDecision: 'NEEDS_DISCUSSION' })], 1)
    const result = evaluateRelease(unresolved, { ...POLICY, requiredTaskCount: 1, requiredRepeats: 1 })
    expect(result.decision).toBe('BLOCKED')
    expect(result.checks.find(check => check.id === 'human-review')?.passed).toBe(false)

    const valid = run('case-b', 1)
    expect(() => RunEvidenceSchema.parse({ ...valid, grade: { ...valid.grade, score: 0.5 } })).toThrow('grade score')
    expect(() => RunEvidenceSchema.parse({ ...valid, grade: { ...valid.grade, passed: false } })).toThrow('grade passed')
  })

  it('refuses comparisons across datasets and reports auditable deltas otherwise', () => {
    const base = aggregateRunEvidence([run('case-a', 1)], 1)
    const candidate = { ...base, evaluationId: 'eval-2', variant: 'single_turn' as const, completionRate: 0.8 }
    expect(compareEvaluations(base, candidate).deltas.completionRate).toBeCloseTo(-0.2)
    expect(() => compareEvaluations(base, { ...candidate, datasetDigest: 'b'.repeat(64) })).toThrow('datasetDigest')
  })

  it('queues every holdout result plus high-risk, disagreement, failed, and manual-review reasons', () => {
    const queue = buildReviewQueue([run('case-a', 1, { passed: false, highRisk: true, disagreement: true, manualReview: true })])
    expect(queue).toHaveLength(1)
    expect(queue[0]?.reasons).toEqual(['HOLDOUT_KEY_CONCLUSION', 'HIGH_RISK', 'GRADER_DISAGREEMENT', 'FAILED_GRADE', 'RUNTIME_MANUAL_REVIEW'])
    expect(queue[0]?.status).toBe('PENDING')
    expect(queue[0]?.reviewer).toBeUndefined()
  })
})
