#!/usr/bin/env bun
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { runDiagnosisCase, DIAGNOSIS_SKILL_SLUG, DIAGNOSIS_SOURCE_SLUG } from '../src/diagnosis/workflow.ts'
import { CommerceError } from '../src/domain/errors.ts'
import { QueryToolInputSchema } from '../src/mcp/schemas.ts'
import { ToolRunner } from '../src/mcp/tool-runner.ts'
import type { ToolEnvelope } from '../src/domain/contracts.ts'
import { runEvalCase } from './case-runner.ts'
import type { EvalCase } from './types.ts'

export type FailureInjectionResult = {
  id: string
  injectedFailure: string
  expectedBehavior: string
  passed: boolean
  latencyMs: number
  details: Record<string, unknown>
  error?: string
}

function envelope(): ToolEnvelope<{ recovered: boolean }> {
  return {
    status: 'ok', data: { recovered: true }, source: 'failure-injection', asOf: '2026-09-15T10:00:00+08:00',
    query: {
      runId: 'run-failure', caseId: 'case-failure', traceId: 'trace-failure', shopId: 'demo-shop', skuIds: ['SKU-C'],
      window: { start: '2026-09-08T00:00:00+08:00', end: '2026-09-15T00:00:00+08:00', timezone: 'Asia/Shanghai' },
      asOf: '2026-09-15T10:00:00+08:00', currency: 'CNY',
    },
    traceId: 'trace-failure', evidence: [], warnings: [],
  }
}

async function probe(id: string, injectedFailure: string, expectedBehavior: string, operation: () => Promise<{ passed: boolean; details?: Record<string, unknown> }>): Promise<FailureInjectionResult> {
  const started = performance.now()
  try {
    const result = await operation()
    return {
      id, injectedFailure, expectedBehavior, passed: result.passed,
      latencyMs: Math.round((performance.now() - started) * 100) / 100,
      details: result.details ?? {},
    }
  } catch (error) {
    return {
      id, injectedFailure, expectedBehavior, passed: false,
      latencyMs: Math.round((performance.now() - started) * 100) / 100,
      details: {}, error: error instanceof Error ? error.message : String(error),
    }
  }
}

function synthetic(id: string, check: string, category: string): EvalCase {
  return { id, split: 'holdout', category, check, sourceCase: 'ads-conversion', expected: 'pass' }
}

function markdown(results: FailureInjectionResult[]): string {
  const rows = results.map(item => `| ${item.id} | ${item.passed ? 'PASS' : 'FAIL'} | ${item.expectedBehavior} | ${item.latencyMs.toFixed(2)}ms |`).join('\n')
  return `# Commerce Agent 故障注入报告

> 所有故障均运行在固定 Fixture、临时 SQLite 和 Mock Executor 中，不连接真实平台。

| 故障 | 结果 | 预期保护行为 | 延迟 |
| --- | --- | --- | ---: |
${rows}

通过：${results.filter(item => item.passed).length}/${results.length}。
`
}

export async function runFailureInjection(options: { outputDir?: string; runtimeRoot?: string } = {}) {
  const packageRoot = resolve(import.meta.dir, '..')
  const fixtureDir = resolve(packageRoot, 'fixtures')
  const outputDir = options.outputDir ?? resolve(packageRoot, 'demo/results')
  const runtimeRoot = options.runtimeRoot ?? await mkdtemp(resolve(tmpdir(), 'commerce-failures-'))
  const results: FailureInjectionResult[] = []

  results.push(await probe('mcp-timeout', 'MCP handler exceeds timeout', 'Return UPSTREAM_TIMEOUT without hanging.', async () => {
    const runner = new ToolRunner({ timeoutMs: 1, maxAttempts: 1 })
    let code = ''
    try {
      await runner.execute('query_sales', { trace_id: 'trace-timeout' }, async () => {
        await new Promise(resolveDelay => setTimeout(resolveDelay, 20))
        return envelope()
      })
    } catch (error) { code = error instanceof CommerceError ? error.code : '' }
    return { passed: code === 'UPSTREAM_TIMEOUT', details: { code } }
  }))

  results.push(await probe('rate-limit-retry', 'First MCP call returns 429-equivalent RATE_LIMITED', 'Retry once within budget and return one successful result.', async () => {
    let attempts = 0
    const runner = new ToolRunner({ maxAttempts: 2, retryBudgetMs: 100, baseDelayMs: 1, sleep: async () => {} })
    const result = await runner.execute('query_sales', { trace_id: 'trace-rate-limit' }, async () => {
      attempts += 1
      if (attempts === 1) throw new CommerceError('RATE_LIMITED', 'injected 429')
      return envelope()
    })
    return { passed: attempts === 2 && result.data.recovered, details: { attempts } }
  }))

  results.push(await probe('invalid-schema', 'Empty query arguments', 'Reject before invoking a data adapter.', async () => {
    const parsed = QueryToolInputSchema.safeParse({})
    return { passed: !parsed.success, details: { issueCount: parsed.success ? 0 : parsed.error.issues.length } }
  }))

  results.push(await probe('missing-data-source', 'Fixture directory does not exist', 'Fail explicitly without creating a report.', async () => {
    let failed = false
    try {
      await runDiagnosisCase('ads-conversion', {
        fixtureDir: resolve(runtimeRoot, 'missing-fixtures'), reportDir: resolve(runtimeRoot, 'missing-source/reports'),
        dbPath: resolve(runtimeRoot, 'missing-source/commerce.sqlite'), skillSlugs: [DIAGNOSIS_SKILL_SLUG], sourceSlugs: [DIAGNOSIS_SOURCE_SLUG],
      })
    } catch { failed = true }
    return { passed: failed, details: { failed } }
  }))

  results.push(await probe('evidence-conflict', 'Two records share an ID but disagree on amount', 'Reject conflicting duplicates.', async () => {
    const result = await runEvalCase(synthetic('failure-evidence-conflict', 'conflicting_duplicate', 'conflict'), runtimeRoot, fixtureDir)
    return { passed: result.passed, details: result.details }
  }))

  results.push(await probe('report-persistence-failure', 'Report output parent is a regular file', 'Fail without returning a report ID.', async () => {
    const blocker = resolve(runtimeRoot, 'report-path-blocker')
    await writeFile(blocker, 'not a directory')
    let failed = false
    try {
      await runDiagnosisCase('ads-conversion', {
        fixtureDir, reportDir: resolve(blocker, 'reports'), dbPath: resolve(runtimeRoot, 'persistence/commerce.sqlite'),
        skillSlugs: [DIAGNOSIS_SKILL_SLUG], sourceSlugs: [DIAGNOSIS_SOURCE_SLUG],
      })
    } catch { failed = true }
    return { passed: failed, details: { failed } }
  }))

  for (const spec of [
    ['approval-expired', 'expired_approval', 'Expired approval', 'Transition to EXPIRED and block execution.'],
    ['proposal-tampered', 'proposal_tamper', 'Proposal parameters changed after approval', 'Reject the content hash mismatch.'],
    ['concurrent-execution', 'concurrent_execution', 'Two execution claims', 'Persist exactly one Mock operation.'],
    ['response-lost', 'response_loss', 'Write succeeds but response is lost', 'Remain UNKNOWN until reconciliation; do not rewrite.'],
    ['session-interrupted', 'session_recovery', 'Case stops after report persistence', 'Resume with parent trace and complete once.'],
  ] as const) {
    results.push(await probe(spec[0], spec[2], spec[3], async () => {
      const result = await runEvalCase(synthetic(`failure-${spec[0]}`, spec[1], 'failure'), runtimeRoot, fixtureDir)
      return { passed: result.passed, details: result.details }
    }))
  }

  await mkdir(outputDir, { recursive: true })
  await writeFile(resolve(outputDir, 'failure-injection-results.json'), `${JSON.stringify({ count: results.length, passed: results.filter(item => item.passed).length, results }, null, 2)}\n`)
  await writeFile(resolve(outputDir, 'failure-injection-report.md'), markdown(results))
  return { results, outputDir }
}

if (import.meta.main) {
  runFailureInjection().then(({ results, outputDir }) => {
    const passed = results.filter(item => item.passed).length
    console.log(JSON.stringify({ cases: results.length, passed, failed: results.length - passed, output_dir: outputDir }, null, 2))
    if (passed !== results.length) process.exitCode = 1
  }).catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
