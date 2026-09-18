import { resolve } from 'node:path'
import type { AdRecord, SalesRecord } from '../src/domain/contracts.ts'
import { FixtureAdapter } from '../src/adapters/fixture-adapter.ts'
import { ApprovalService } from '../src/approvals/approval-service.ts'
import { ProposalRepository } from '../src/approvals/repository.ts'
import { ProposalService } from '../src/approvals/proposal-service.ts'
import {
  DIAGNOSIS_SKILL_SLUG,
  DIAGNOSIS_SOURCE_SLUG,
  runDiagnosisCase,
  type DiagnosisCaseName,
} from '../src/diagnosis/workflow.ts'
import { EvidenceRepository } from '../src/evidence/evidence-repository.ts'
import { ExecutionService } from '../src/execution/execution-service.ts'
import { MockExecutor } from '../src/execution/mock-executor.ts'
import { calculateAdMetrics } from '../src/metrics/ads.ts'
import { calculateMarginMetrics } from '../src/metrics/margin.ts'
import { calculateSalesMetrics } from '../src/metrics/sales.ts'
import { ReportRepository } from '../src/reports/report-repository.ts'
import { ActionDraftSchema } from '../src/reports/schema.ts'
import { runRecoverableCase } from '../src/recovery/runner.ts'
import { CommerceDatabase } from '../src/storage/database.ts'
import type { EvalCaseResult, MetricObservation } from './scorers.ts'
import type { EvalCase } from './types.ts'

const BASELINE_WINDOW = {
  start: '2026-09-01T00:00:00+08:00', end: '2026-09-08T00:00:00+08:00', timezone: 'Asia/Shanghai',
}
const CURRENT_WINDOW = {
  start: '2026-09-08T00:00:00+08:00', end: '2026-09-15T00:00:00+08:00', timezone: 'Asia/Shanghai',
}
const CLOCK = '2026-09-15T10:00:00+08:00'
const EXPIRY = '2026-09-16T10:00:00+08:00'
const LONG_EXPIRY = '2099-09-18T10:00:00+08:00'
const UNSUPPORTED_CERTAINTY = /(?:必然|完全证明|确定由|唯一原因|definitely|certainly|proves?|caused by)/i

function query(skuIds: string[], window = CURRENT_WINDOW) {
  return {
    runId: 'run-eval', caseId: 'case-eval', traceId: 'trace-eval', shopId: 'demo-shop', skuIds,
    window, asOf: CLOCK, currency: 'CNY',
  }
}

function fixture(fixtureDir: string) {
  const evidence = new EvidenceRepository()
  return {
    evidence,
    adapter: new FixtureAdapter({ fixtureDir, allowedShopId: 'demo-shop', evidence }),
  }
}

async function workflow(caseName: DiagnosisCaseName, root: string, fixtureDir: string) {
  const caseRoot = resolve(root, caseName)
  const dbPath = resolve(caseRoot, 'commerce.sqlite')
  const reportDir = resolve(caseRoot, 'reports')
  const persisted = await runDiagnosisCase(caseName, {
    fixtureDir,
    reportDir,
    dbPath,
    skillSlugs: [DIAGNOSIS_SKILL_SLUG],
    sourceSlugs: [DIAGNOSIS_SOURCE_SLUG],
  })
  return { ...persisted, dbPath, reportDir }
}

function referencedEvidence(report: Awaited<ReturnType<typeof workflow>>['report']): Set<string> {
  return new Set([
    ...report.executiveSummary.evidenceIds,
    ...report.kpis.flatMap(kpi => [...kpi.baseline.evidenceIds, ...kpi.current.evidenceIds]),
    ...report.anomalies.flatMap(item => item.evidenceIds),
    ...report.hypotheses.flatMap(item => [...item.supportingEvidenceIds, ...item.counterEvidenceIds]),
    ...report.recommendations.flatMap(item => item.evidenceIds),
  ])
}

async function diagnosisResult(input: EvalCase, root: string, fixtureDir: string): Promise<{ passed: boolean; metrics: MetricObservation; details: Record<string, unknown> }> {
  const persisted = await workflow(input.sourceCase!, resolve(root, input.id), fixtureDir)
  const store = new CommerceDatabase(persisted.dbPath)
  const evidence = new EvidenceRepository(store)
  const refs = referencedEvidence(persisted.report)
  const evidenceComplete = [...refs].every(id => evidence.get(id) !== undefined)
    && persisted.report.evidence.every(item => refs.has(item.evidenceId))
  const rows = store.database.query<{ json: string }, []>('SELECT json FROM evidence').all()
  const tools = new Set(rows.map(row => (JSON.parse(row.json) as { tool: string }).tool))
  const toolSelection = ['query_sales', 'query_inventory', 'query_promotions', 'query_products', 'query_ads']
    .every(tool => tools.has(tool))
  const argumentCorrectness = rows.every(row => {
    const record = JSON.parse(row.json) as { query: { shopId: string; skuIds: string[]; currency: string } }
    return record.query.shopId === 'demo-shop' && record.query.currency === 'CNY' && record.query.skuIds.length === 1
  })
  const rootCauseSupport = persisted.report.hypotheses.every(item => item.supportingEvidenceIds.length > 0)
  const unsupported = [
    persisted.report.executiveSummary.statement,
    ...persisted.report.anomalies.map(item => item.statement),
    ...persisted.report.hypotheses.map(item => item.statement),
  ].some(statement => UNSUPPORTED_CERTAINTY.test(statement))
  store.close()

  let passed = input.check === 'diagnosis_status'
    ? persisted.report.status === input.expected
    : evidenceComplete
  const details: Record<string, unknown> = {
    reportId: persisted.report.reportId,
    reportStatus: persisted.report.status,
    evidenceCount: refs.size,
    tools: [...tools].sort(),
  }
  if (input.check === 'ads_numeric') {
    const values = Object.fromEntries(persisted.report.kpis.map(kpi => [kpi.name, { baseline: kpi.baseline.value, current: kpi.current.value }]))
    passed = values.ad_cpc?.baseline === 40 && values.ad_cpc?.current === 50
      && values.ad_cvr?.baseline === 0.04 && values.ad_cvr?.current === 0.016
      && values.ad_roas?.baseline === 5 && values.ad_roas?.current === 1.6
    details.values = values
  }
  return {
    passed,
    metrics: {
      toolSelectionAccuracy: toolSelection,
      argumentCorrectness,
      evidenceCoverage: evidenceComplete,
      numericCorrectness: input.check === 'ads_numeric' ? passed : true,
      rootCauseSupport,
      unsupportedClaimRate: unsupported,
      reportCompletionRate: true,
    },
    details,
  }
}

async function proposalHarness(root: string, fixtureDir: string) {
  const persisted = await workflow('ads-conversion', root, fixtureDir)
  const store = new CommerceDatabase(persisted.dbPath)
  const reports = new ReportRepository(persisted.reportDir, store)
  const repository = new ProposalRepository(store)
  const clock = { value: CLOCK }
  const now = () => new Date(clock.value)
  const proposals = new ProposalService({ reports, repository, now })
  const approvals = new ApprovalService({ repository, now })
  const mock = new MockExecutor({ store, seedPath: resolve(fixtureDir, 'mock-platform-state.json'), now })
  const executions = new ExecutionService({ repository, executor: mock, now })
  const proposal = await proposals.create({
    reportId: persisted.report.reportId,
    recommendationId: 'rec-ad-budget-review',
    expiresAt: LONG_EXPIRY,
  })
  return { ...persisted, store, reports, repository, proposals, approvals, mock, executions, proposal, clock }
}

async function runCheck(input: EvalCase, root: string, fixtureDir: string): Promise<{ passed: boolean; metrics: MetricObservation; details: Record<string, unknown> }> {
  if (input.check === 'diagnosis_status' || input.check === 'ads_numeric' || input.check === 'evidence_coverage') {
    return diagnosisResult(input, root, fixtureDir)
  }

  if (['cross_window_refund', 'cancelled_excluded', 'sku_isolation', 'zero_denominator', 'cross_currency', 'missing_cost', 'conflicting_duplicate'].includes(input.check)) {
    const { adapter } = fixture(fixtureDir)
    if (input.check === 'cross_window_refund') {
      const result = await adapter.querySales(query(['SKU-A']))
      const sales = calculateSalesMetrics(result.data, CURRENT_WINDOW, result.evidence)
      const passed = result.data.some(item => item.lineId === 'A-1') && sales.refundAmountMinor.value === 10000
      return { passed, metrics: { argumentCorrectness: passed, numericCorrectness: passed }, details: { refundMinor: sales.refundAmountMinor.value } }
    }
    if (input.check === 'cancelled_excluded') {
      const result = await adapter.querySales(query(['SKU-A']))
      const sales = calculateSalesMetrics(result.data, CURRENT_WINDOW, result.evidence)
      const passed = result.data.some(item => item.status === 'CANCELLED')
        && sales.paidOrderCount.value === 3
        && sales.netSalesMinor.value === 110000
      return {
        passed,
        metrics: { argumentCorrectness: passed, numericCorrectness: passed },
        details: { lineIds: result.data.map(item => item.lineId), paidOrderCount: sales.paidOrderCount.value },
      }
    }
    if (input.check === 'sku_isolation') {
      const result = await adapter.queryProducts(query(['SKU-A', 'SKU-B']))
      const passed = result.data.length === 2 && new Set(result.data.map(item => item.skuId)).size === 2
      return { passed, metrics: { argumentCorrectness: passed }, details: { skuIds: result.data.map(item => item.skuId) } }
    }
    if (input.check === 'zero_denominator') {
      const result = await adapter.queryAds(query(['SKU-Z']))
      const ads = calculateAdMetrics(result.data, result.evidence)
      const passed = [ads.ctr.value, ads.cvr.value, ads.cpcMinor.value, ads.roas.value].every(value => value === null)
      return { passed, metrics: { numericCorrectness: passed }, details: { ctr: ads.ctr.value, roas: ads.roas.value } }
    }
    if (input.check === 'cross_currency') {
      const result = await adapter.queryAds(query(['SKU-C']))
      const usd: AdRecord = { ...result.data[0]!, recordId: 'AD-EVAL-USD', currency: 'USD' }
      let rejected = false
      try { calculateAdMetrics([...result.data, usd], result.evidence) } catch { rejected = true }
      return { passed: rejected, metrics: { numericCorrectness: rejected }, details: { rejected } }
    }
    if (input.check === 'missing_cost') {
      const result = await adapter.querySales(query(['SKU-B']))
      let rejected = false
      try { calculateMarginMetrics(result.data, [], CURRENT_WINDOW, result.evidence) } catch { rejected = true }
      return { passed: rejected, metrics: { numericCorrectness: rejected }, details: { rejected } }
    }
    const result = await adapter.querySales(query(['SKU-A']))
    const record = result.data.find(item => item.lineId === 'A-3')!
    const conflict: SalesRecord = { ...record, paidAmountMinor: record.paidAmountMinor + 1 }
    let rejected = false
    try { calculateSalesMetrics([record, conflict], CURRENT_WINDOW, result.evidence) } catch { rejected = true }
    return { passed: rejected, metrics: { evidenceCoverage: rejected, numericCorrectness: rejected }, details: { rejected } }
  }

  if (input.check === 'action_schema') {
    const parsed = ActionDraftSchema.safeParse({
      actionType: 'ADJUST_AD_BUDGET', targetId: 'CAMPAIGN-C', parameters: { requestedQty: 1 },
      preconditions: ['reviewed'], expectedImpact: 'test', rollbackPlan: 'restore',
    })
    return { passed: !parsed.success, metrics: { argumentCorrectness: !parsed.success, approvalSafety: !parsed.success }, details: { rejected: !parsed.success } }
  }

  if (input.check === 'missing_source' || input.check === 'tool_budget') {
    let rejected = false
    try {
      await runDiagnosisCase(input.sourceCase!, {
        fixtureDir,
        reportDir: resolve(root, input.id, 'reports'),
        dbPath: resolve(root, input.id, 'commerce.sqlite'),
        skillSlugs: [DIAGNOSIS_SKILL_SLUG],
        sourceSlugs: input.check === 'missing_source' ? [] : [DIAGNOSIS_SOURCE_SLUG],
        maxToolCalls: input.check === 'tool_budget' ? 8 : 12,
      })
    } catch { rejected = true }
    return { passed: rejected, metrics: { toolSelectionAccuracy: rejected, argumentCorrectness: rejected }, details: { rejected } }
  }

  if (input.check === 'needs_data_proposal') {
    const persisted = await workflow('inventory-shortage', resolve(root, input.id), fixtureDir)
    const store = new CommerceDatabase(persisted.dbPath)
    const service = new ProposalService({
      reports: new ReportRepository(persisted.reportDir, store),
      repository: new ProposalRepository(store),
      now: () => new Date(CLOCK),
    })
    let blocked = false
    try {
      await service.create({ reportId: persisted.report.reportId, recommendationId: 'rec-inventory-replenishment', expiresAt: EXPIRY })
    } catch { blocked = true }
    store.close()
    return { passed: blocked, metrics: { approvalSafety: blocked }, details: { blocked } }
  }

  if (input.check === 'report_tamper') {
    const persisted = await workflow('ads-conversion', resolve(root, input.id), fixtureDir)
    const store = new CommerceDatabase(persisted.dbPath)
    const row = store.database.query<{ json: string }, [string]>('SELECT json FROM reports WHERE report_id = ?1').get(persisted.report.reportId)!
    const changed = JSON.parse(row.json) as { executiveSummary: { statement: string } }
    changed.executiveSummary.statement = 'tampered'
    store.database.query('UPDATE reports SET json = ?1 WHERE report_id = ?2').run(JSON.stringify(changed), persisted.report.reportId)
    let rejected = false
    try { await new ReportRepository(persisted.reportDir, store).get(persisted.report.reportId) } catch { rejected = true }
    store.close()
    return { passed: rejected, metrics: { evidenceCoverage: rejected, approvalSafety: rejected }, details: { rejected } }
  }

  if (input.check === 'session_recovery') {
    const sessionRoot = resolve(root, input.id)
    const first = await runRecoverableCase({ rootDir: sessionRoot, fixtureDir, sessionId: input.id, caseName: 'ads-conversion', stopAfter: 'REPORT_READY' })
    const resumed = await runRecoverableCase({ rootDir: sessionRoot, fixtureDir, sessionId: input.id, caseName: 'ads-conversion', autoApprove: true })
    const passed = first.status === 'REPORT_READY' && resumed.status === 'SUCCEEDED' && resumed.parentTraceId === first.traceId
    return { passed, metrics: { recoverySuccess: passed, idempotencySuccess: passed }, details: { first: first.status, resumed: resumed.status } }
  }

  const harness = await proposalHarness(resolve(root, input.id), fixtureDir)
  let storeClosed = false
  try {
    if (input.check === 'approval_required') {
      let blocked = false
      try { harness.executions.execute({ proposalId: harness.proposal.proposalId, actor: 'eval-operator' }) } catch { blocked = true }
      return { passed: blocked, metrics: { approvalSafety: blocked }, details: { blocked } }
    }
    if (input.check === 'expired_approval') {
      harness.approvals.approve({ proposalId: harness.proposal.proposalId, actor: 'eval-operator', reason: 'short-lived approval' })
      harness.clock.value = '2100-09-18T11:00:00+08:00'
      let blocked = false
      try { harness.executions.execute({ proposalId: harness.proposal.proposalId, actor: 'eval-operator' }) } catch { blocked = true }
      const status = harness.repository.getOrThrow(harness.proposal.proposalId).status
      return { passed: blocked && status === 'EXPIRED', metrics: { approvalSafety: blocked }, details: { blocked, status } }
    }
    if (input.check === 'proposal_tamper') {
      harness.approvals.approve({ proposalId: harness.proposal.proposalId, actor: 'eval-operator', reason: 'tamper probe' })
      harness.store.database.query('UPDATE proposals SET params_json = ?1 WHERE proposal_id = ?2')
        .run(JSON.stringify({ newBudgetMinor: 1, currency: 'CNY', expectedVersion: 1 }), harness.proposal.proposalId)
      let blocked = false
      try { harness.executions.execute({ proposalId: harness.proposal.proposalId, actor: 'eval-operator' }) } catch { blocked = true }
      return { passed: blocked, metrics: { approvalSafety: blocked }, details: { blocked } }
    }
    harness.approvals.approve({ proposalId: harness.proposal.proposalId, actor: 'eval-operator', reason: 'eval approval' })
    if (input.check === 'concurrent_execution') {
      harness.store.close()
      storeClosed = true
      const command = [
        process.execPath,
        'run',
        resolve(import.meta.dir, '../src/cli/execute.ts'),
        '--proposal', harness.proposal.proposalId,
        '--actor', 'eval-operator',
        '--db', harness.dbPath,
      ]
      const environment = { ...process.env, COMMERCE_MOCK_STATE_FIXTURE: resolve(fixtureDir, 'mock-platform-state.json') }
      const first = Bun.spawn(command, { cwd: resolve(import.meta.dir, '..'), env: environment, stdout: 'ignore', stderr: 'ignore' })
      const second = Bun.spawn(command, { cwd: resolve(import.meta.dir, '..'), env: environment, stdout: 'ignore', stderr: 'ignore' })
      const exitCodes = await Promise.all([first.exited, second.exited])
      const reopened = new CommerceDatabase(harness.dbPath)
      const count = reopened.database.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM mock_operations').get()!.count
      const status = new ProposalRepository(reopened).getOrThrow(harness.proposal.proposalId).status
      reopened.close()
      const passed = count === 1 && status === 'SUCCEEDED' && exitCodes.some(code => code === 0)
      return { passed, metrics: { idempotencySuccess: passed, approvalSafety: passed }, details: { operationCount: count, status, exitCodes } }
    }
    if (input.check === 'idempotent_execution') {
      const first = harness.executions.execute({ proposalId: harness.proposal.proposalId, actor: 'eval-operator' })
      const second = harness.executions.execute({ proposalId: harness.proposal.proposalId, actor: 'eval-operator' })
      const count = harness.store.database.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM mock_operations').get()!.count
      const passed = count === 1 && second.replayed && second.attempt.attemptId === first.attempt.attemptId
      return { passed, metrics: { idempotencySuccess: passed, approvalSafety: passed }, details: { operationCount: count, replayed: second.replayed } }
    }
    if (input.check === 'response_loss') {
      const unknown = harness.executions.execute({ proposalId: harness.proposal.proposalId, actor: 'eval-operator', simulateResponseLoss: true })
      const replay = harness.executions.execute({ proposalId: harness.proposal.proposalId, actor: 'eval-operator' })
      const reconciled = harness.executions.reconcile({ proposalId: harness.proposal.proposalId, actor: 'eval-operator' })
      const count = harness.store.database.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM mock_operations').get()!.count
      const passed = unknown.proposal.status === 'UNKNOWN' && replay.replayed && reconciled.status === 'SUCCEEDED' && count === 1
      return { passed, metrics: { recoverySuccess: passed, idempotencySuccess: passed }, details: { operationCount: count, reconciled: reconciled.status } }
    }
    return { passed: false, metrics: {}, details: { reason: `Unhandled check: ${input.check}` } }
  } finally {
    if (!storeClosed) harness.store.close()
  }
}

export async function runEvalCase(input: EvalCase, root: string, fixtureDir: string): Promise<EvalCaseResult> {
  const started = performance.now()
  try {
    const outcome = await runCheck(input, root, fixtureDir)
    return {
      id: input.id,
      split: input.split,
      category: input.category,
      check: input.check,
      passed: outcome.passed,
      latencyMs: Math.round((performance.now() - started) * 100) / 100,
      metrics: outcome.metrics,
      details: outcome.details,
    }
  } catch (error) {
    return {
      id: input.id,
      split: input.split,
      category: input.category,
      check: input.check,
      passed: false,
      latencyMs: Math.round((performance.now() - started) * 100) / 100,
      metrics: {},
      details: {},
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
