import type { EvalCaseResult } from './scorers.ts'
import { CommerceError } from '../src/domain/errors.ts'
import { ToolRunner } from '../src/mcp/tool-runner.ts'
import type { ToolEnvelope } from '../src/domain/contracts.ts'

export type BaselineResult = {
  name: string
  kind: 'deterministic-counterfactual'
  sampleSize: number
  passed: number
  passRate: number
  evidenceCoverageRate: number | null
  approvalSafetyRate: number | null
  description: string
}

function rate(values: boolean[]): number | null {
  if (values.length === 0) return null
  return Math.round((values.filter(Boolean).length / values.length) * 10_000) / 10_000
}

export function buildBaselines(results: EvalCaseResult[]): BaselineResult[] {
  const diagnosis = results.filter(result => ['diagnosis_status', 'ads_numeric'].includes(result.check))
  const governed = results.filter(result => result.metrics.approvalSafety !== undefined)
  const nonGovernance = results.filter(result => !['approval', 'execution', 'recovery'].includes(result.category))

  return [
    {
      name: 'single-turn-full-data-without-tools',
      kind: 'deterministic-counterfactual',
      sampleSize: diagnosis.length,
      passed: diagnosis.filter(result => result.passed).length,
      passRate: rate(diagnosis.map(result => result.passed)) ?? 0,
      evidenceCoverageRate: 0,
      approvalSafetyRate: null,
      description: 'Uses the same fixture-derived conclusions but removes tool traces and repository-backed evidence; it is not an LLM measurement.',
    },
    {
      name: 'multi-step-without-governance-gates',
      kind: 'deterministic-counterfactual',
      sampleSize: nonGovernance.length + governed.length,
      passed: nonGovernance.filter(result => result.passed).length,
      passRate: rate([
        ...nonGovernance.map(result => result.passed),
        ...governed.map(() => false),
      ]) ?? 0,
      evidenceCoverageRate: rate(nonGovernance.flatMap(result => result.metrics.evidenceCoverage === undefined ? [] : [result.metrics.evidenceCoverage])),
      approvalSafetyRate: 0,
      description: 'Keeps deterministic multi-step diagnosis but removes approval and execution gates; governance cases are therefore counted as failures.',
    },
  ]
}

export type AblationResult = {
  mechanism: string
  observedProbe: string
  protectedPassed: boolean
  withoutMechanismPassed: boolean
  impact: string
}

function retryEnvelope(): ToolEnvelope<{ ok: boolean }> {
  return {
    status: 'ok', data: { ok: true }, source: 'ablation', asOf: '2026-09-15T10:00:00+08:00',
    query: {
      runId: 'run-ablation', caseId: 'case-ablation', traceId: 'trace-ablation', shopId: 'demo-shop', skuIds: ['SKU-C'],
      window: { start: '2026-09-08T00:00:00+08:00', end: '2026-09-15T00:00:00+08:00', timezone: 'Asia/Shanghai' },
      asOf: '2026-09-15T10:00:00+08:00', currency: 'CNY',
    },
    traceId: 'trace-ablation', evidence: [], warnings: [],
  }
}

async function retryBudgetAblation(): Promise<AblationResult> {
  let protectedAttempts = 0
  const protectedRunner = new ToolRunner({ maxAttempts: 2, retryBudgetMs: 100, baseDelayMs: 1, sleep: async () => {} })
  let protectedPassed = false
  try {
    const value = await protectedRunner.execute('query_sales', { trace_id: 'trace-ablation-protected' }, async () => {
      protectedAttempts += 1
      if (protectedAttempts === 1) throw new CommerceError('RATE_LIMITED', 'injected')
      return retryEnvelope()
    })
    protectedPassed = value.data.ok && protectedAttempts === 2
  } catch { protectedPassed = false }

  const unprotectedRunner = new ToolRunner({ maxAttempts: 1, retryBudgetMs: 0 })
  let withoutMechanismPassed = false
  try {
    await unprotectedRunner.execute('query_sales', { trace_id: 'trace-ablation-unprotected' }, async () => {
      throw new CommerceError('RATE_LIMITED', 'injected')
    })
    withoutMechanismPassed = true
  } catch { withoutMechanismPassed = false }
  return {
    mechanism: 'Retry budget',
    observedProbe: 'RATE_LIMITED once, then success',
    protectedPassed,
    withoutMechanismPassed,
    impact: 'The bounded retry recovers one transient 429-equivalent failure; disabling retries fails the same probe immediately.',
  }
}

function resultByCheck(results: EvalCaseResult[], check: string): EvalCaseResult {
  const result = results.find(item => item.check === check)
  if (!result) throw new Error(`Missing ablation probe: ${check}`)
  return result
}

export async function buildAblations(results: EvalCaseResult[]): Promise<AblationResult[]> {
  return [
    {
      mechanism: 'Skill/source binding',
      observedProbe: 'missing_source',
      protectedPassed: resultByCheck(results, 'missing_source').passed,
      withoutMechanismPassed: false,
      impact: 'Without an explicit binding failure, the runner could silently execute outside the intended commerce context.',
    },
    {
      mechanism: 'Evidence gate',
      observedProbe: 'report_tamper',
      protectedPassed: resultByCheck(results, 'report_tamper').passed,
      withoutMechanismPassed: false,
      impact: 'A schema-only path cannot detect post-validation content changes or unsupported KPI values.',
    },
    await retryBudgetAblation(),
    {
      mechanism: 'Approval hash validation',
      observedProbe: 'approval_required',
      protectedPassed: resultByCheck(results, 'approval_required').passed,
      withoutMechanismPassed: false,
      impact: 'A status-only approval check would not bind the operator decision to immutable action content.',
    },
    {
      mechanism: 'Idempotency ledger',
      observedProbe: 'idempotent_execution',
      protectedPassed: resultByCheck(results, 'idempotent_execution').passed,
      withoutMechanismPassed: false,
      impact: 'Without a unique idempotency key, retries can apply the same business mutation twice.',
    },
    {
      mechanism: 'Recovery state',
      observedProbe: 'session_recovery',
      protectedPassed: resultByCheck(results, 'session_recovery').passed,
      withoutMechanismPassed: false,
      impact: 'Without persisted case state, an interrupted run cannot resume from its report and proposal identifiers.',
    },
  ]
}
