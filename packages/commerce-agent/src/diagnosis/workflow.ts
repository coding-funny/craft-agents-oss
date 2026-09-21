import { resolve } from 'node:path'
import { FixtureAdapter } from '../adapters/fixture-adapter.ts'
import type { TimeRange, ToolEnvelope } from '../domain/contracts.ts'
import { CommerceError } from '../domain/errors.ts'
import { localTestPrincipal } from '../auth/local-test.ts'
import { EvidenceRepository } from '../evidence/evidence-repository.ts'
import { ToolRunner, type ToolExecutionContext } from '../mcp/tool-runner.ts'
import type { TraceRecorder } from '../mcp/trace.ts'
import { ReportRepository, type PersistedReport } from '../reports/report-repository.ts'
import type {
  DiagnosisReportDraft,
  KpiComparison,
  ReportFact,
  ReportRecommendation,
} from '../reports/schema.ts'
import { validateAndPersistReport } from '../reports/validate-report.ts'
import { computeMarginTool } from '../tools/compute-margin.ts'
import type { CommerceToolDependencies } from '../tools/context.ts'
import { queryAdsTool } from '../tools/query-ads.ts'
import { queryInventoryTool } from '../tools/query-inventory.ts'
import { queryPromotionsTool } from '../tools/query-promotions.ts'
import { querySalesTool } from '../tools/query-sales.ts'
import { buildHypothesis, changeRate, diagnoseAdvertising, selectDiagnosisRoute } from './hypotheses.ts'
import { CommerceDatabase } from '../storage/database.ts'
import { ProposalRepository } from '../approvals/repository.ts'
import { ProposalService } from '../approvals/proposal-service.ts'

export const DIAGNOSIS_SKILL_SLUG = 'commerce-diagnosis'
export const DIAGNOSIS_SOURCE_SLUG = 'commerce'

export const DIAGNOSIS_CASES = {
  'inventory-shortage': { skuId: 'SKU-A', traceId: 'trace-inventory-shortage-001' },
  'promotion-margin': { skuId: 'SKU-B', traceId: 'trace-promotion-margin-001' },
  'ads-conversion': { skuId: 'SKU-C', traceId: 'trace-ads-conversion-001' },
} as const

export type DiagnosisCaseName = keyof typeof DIAGNOSIS_CASES

const BASELINE_WINDOW: TimeRange = {
  start: '2026-09-01T00:00:00+08:00',
  end: '2026-09-08T00:00:00+08:00',
  timezone: 'Asia/Shanghai',
}

const CURRENT_WINDOW: TimeRange = {
  start: '2026-09-08T00:00:00+08:00',
  end: '2026-09-15T00:00:00+08:00',
  timezone: 'Asia/Shanghai',
}

const GENERATED_AT = '2026-09-15T09:00:00+08:00'

type WorkflowOptions = {
  fixtureDir: string
  reportDir: string
  dbPath?: string
  skillSlugs: string[]
  sourceSlugs: string[]
  traceRecorder?: TraceRecorder
  maxToolCalls?: number
}

type QueryArgs = ReturnType<typeof queryArgs>

function assertRuntimeBindings(options: WorkflowOptions): void {
  if (!options.skillSlugs.includes(DIAGNOSIS_SKILL_SLUG)) {
    throw new CommerceError('INVALID_ARGUMENT', `Required Skill is not loaded: ${DIAGNOSIS_SKILL_SLUG}`)
  }
  if (!options.sourceSlugs.includes(DIAGNOSIS_SOURCE_SLUG)) {
    throw new CommerceError('INVALID_ARGUMENT', `Required Source is not enabled: ${DIAGNOSIS_SOURCE_SLUG}`)
  }
}

function queryArgs(caseName: DiagnosisCaseName, window: TimeRange) {
  const definition = DIAGNOSIS_CASES[caseName]
  return {
    run_id: `run-${caseName}-001`,
    case_id: caseName,
    trace_id: definition.traceId,
    shop_id: 'demo-shop',
    sku_ids: [definition.skuId],
    window,
    as_of: GENERATED_AT,
    currency: 'CNY',
  }
}

async function runTool<T extends ToolEnvelope<unknown>>(
  runner: ToolRunner,
  name: string,
  args: QueryArgs,
  handler: (args: Record<string, unknown>, context: ToolExecutionContext) => Promise<T>,
): Promise<T> {
  return runner.execute(name, args, handler)
}

function metricKpi(
  name: string,
  baseline: { value: number | null; unit: string; evidence: Array<{ evidenceId: string }> },
  current: { value: number | null; unit: string; evidence: Array<{ evidenceId: string }> },
): KpiComparison {
  return {
    name,
    baseline: { value: baseline.value, unit: baseline.unit, evidenceIds: [...new Set(baseline.evidence.map(item => item.evidenceId))] },
    current: { value: current.value, unit: current.unit, evidenceIds: [...new Set(current.evidence.map(item => item.evidenceId))] },
    changeRate: changeRate(baseline.value, current.value),
  }
}

function uniqueEvidenceIds(...groups: string[][]): string[] {
  return [...new Set(groups.flat())]
}

function referencedEvidenceIds(report: Omit<DiagnosisReportDraft, 'evidence'>): string[] {
  return [...new Set([
    ...report.executiveSummary.evidenceIds,
    ...report.kpis.flatMap(kpi => [...kpi.baseline.evidenceIds, ...kpi.current.evidenceIds]),
    ...report.anomalies.flatMap(item => item.evidenceIds),
    ...report.hypotheses.flatMap(item => [...item.supportingEvidenceIds, ...item.counterEvidenceIds]),
    ...report.recommendations.flatMap(item => item.evidenceIds),
  ])].sort()
}

export async function runDiagnosisCase(
  caseName: DiagnosisCaseName,
  options: WorkflowOptions,
): Promise<PersistedReport> {
  assertRuntimeBindings(options)
  const definition = DIAGNOSIS_CASES[caseName]
  if (!definition) throw new CommerceError('INVALID_ARGUMENT', `Unknown diagnosis case: ${caseName}`)

  const store = new CommerceDatabase(options.dbPath ?? ':memory:')
  try {
  const evidence = new EvidenceRepository(store)
  const reports = new ReportRepository(options.reportDir, store)
  const proposals = new ProposalService({ reports, repository: new ProposalRepository(store), now: () => new Date(GENERATED_AT) })
  const adapter = new FixtureAdapter({
    fixtureDir: options.fixtureDir,
    allowedShopId: 'demo-shop',
    evidence,
  })
  const dependencies: CommerceToolDependencies = {
    adapter,
    evidence,
    reports,
    proposals,
    principal: localTestPrincipal({ actorId: 'diagnosis-agent', roles: ['OPERATOR'] }),
    now: () => new Date(GENERATED_AT),
  }
  const runner = new ToolRunner({ traceRecorder: options.traceRecorder })
  const baselineArgs = queryArgs(caseName, BASELINE_WINDOW)
  const currentArgs = queryArgs(caseName, CURRENT_WINDOW)
  const budget = { used: 0, max: options.maxToolCalls ?? 12 }
  const plannedToolCalls = 9
  if (budget.max < plannedToolCalls) {
    throw new CommerceError('INVALID_ARGUMENT', `Diagnosis tool-call budget exceeded: requires ${plannedToolCalls}, limit ${budget.max}`)
  }
  const call = <T extends ToolEnvelope<unknown>>(
    name: string,
    args: QueryArgs,
    handler: (args: Record<string, unknown>, context: ToolExecutionContext) => Promise<T>,
  ): Promise<T> => {
    budget.used += 1
    return runTool(runner, name, args, handler)
  }
  const [baselineSales, currentSales, baselineInventory, currentInventory, promotions, baselineMargin, currentMargin, baselineAds, currentAds] = await Promise.all([
    call('query_sales', baselineArgs, (args, context) => querySalesTool(args, context, dependencies)),
    call('query_sales', currentArgs, (args, context) => querySalesTool(args, context, dependencies)),
    call('query_inventory', baselineArgs, (args, context) => queryInventoryTool(args, context, dependencies)),
    call('query_inventory', currentArgs, (args, context) => queryInventoryTool(args, context, dependencies)),
    call('query_promotions', currentArgs, (args, context) => queryPromotionsTool(args, context, dependencies)),
    call('compute_margin', baselineArgs, (args, context) => computeMarginTool(args, context, dependencies)),
    call('compute_margin', currentArgs, (args, context) => computeMarginTool(args, context, dependencies)),
    call('query_ads', baselineArgs, (args, context) => queryAdsTool(args, context, dependencies)),
    call('query_ads', currentArgs, (args, context) => queryAdsTool(args, context, dependencies)),
  ])

  const salesKpi = metricKpi('net_sales', baselineSales.data.metrics.netSalesMinor, currentSales.data.metrics.netSalesMinor)
  const salesEvidence = uniqueEvidenceIds(salesKpi.baseline.evidenceIds, salesKpi.current.evidenceIds)
  let kpis: KpiComparison[] = [salesKpi]
  let anomalies: ReportFact[]
  let hypotheses: DiagnosisReportDraft['hypotheses']
  let recommendations: ReportRecommendation[]
  let summary: DiagnosisReportDraft['executiveSummary']
  const risks: string[] = ['Fixture evidence demonstrates the workflow but is not production platform data.']
  const unknowns: DiagnosisReportDraft['unknowns'] = []
  const route = selectDiagnosisRoute({
    baselineNetSales: baselineSales.data.metrics.netSalesMinor.value,
    currentNetSales: currentSales.data.metrics.netSalesMinor.value,
    currentStockoutSkuCount: currentInventory.data.metrics.stockoutSkuCount.value,
    promotionCount: promotions.data.length,
    baselineContributionRate: baselineMargin.data.contributionRate.value,
    currentContributionRate: currentMargin.data.contributionRate.value,
    advertisingAvailable: baselineAds.status !== 'missing' && currentAds.status !== 'missing',
  })

  if (route === 'INVENTORY_CONSTRAINT') {
    const inventoryKpi = metricKpi(
      'stockout_sku_count',
      baselineInventory.data.metrics.stockoutSkuCount,
      currentInventory.data.metrics.stockoutSkuCount,
    )
    kpis = [...kpis, inventoryKpi]
    const inventoryEvidence = currentInventory.evidence.map(item => item.evidenceId)
    const promotionEvidence = promotions.evidence.map(item => item.evidenceId)
    anomalies = [{
      kind: 'FACT',
      statement: 'Net sales decreased while the latest inventory evidence contains a stockout snapshot.',
      evidenceIds: uniqueEvidenceIds(salesEvidence, inventoryEvidence),
    }]
    hypotheses = [buildHypothesis({
      statement: 'Inventory availability is associated with the observed sales decline; promotion evidence does not remove that constraint.',
      supportingEvidenceIds: uniqueEvidenceIds(salesEvidence, inventoryEvidence),
      counterEvidenceIds: promotionEvidence,
      limitations: ['Advertising attribution is unavailable for this SKU and period.', 'The evidence supports association, not proven causality.'],
      missingCriticalData: false,
    })]
    summary = { statement: 'The strongest observed constraint is inventory availability alongside lower net sales.', evidenceIds: uniqueEvidenceIds(salesEvidence, inventoryEvidence) }
    recommendations = [{
      recommendationId: 'rec-inventory-replenishment',
      kind: 'RECOMMENDATION',
      action: 'Prepare a replenishment proposal and review inbound lead time before any inventory commitment.',
      rationale: 'The current window includes stockout evidence and lower net sales.',
      riskLevel: 'HIGH',
      evidenceIds: uniqueEvidenceIds(salesEvidence, inventoryEvidence),
      proposalDraft: 'Proposed only: restore a review-approved safety stock after validating forecast and supplier lead time.',
      actionDraft: {
        actionType: 'CREATE_REPLENISHMENT_TASK',
        targetId: definition.skuId,
        parameters: { requestedQty: 50 },
        preconditions: ['Latest available inventory remains zero.', 'Supplier lead time is reviewed by an operator.'],
        expectedImpact: 'Restore a review-approved safety stock for the constrained SKU.',
        rollbackPlan: 'Cancel the mock replenishment task before fulfillment begins.',
      },
    }]
  } else if (route === 'PROMOTION_MARGIN') {
    const marginKpi = metricKpi('contribution_rate', baselineMargin.data.contributionRate, currentMargin.data.contributionRate)
    kpis = [...kpis, marginKpi]
    const promotionEvidence = promotions.evidence.map(item => item.evidenceId)
    const marginEvidence = uniqueEvidenceIds(marginKpi.baseline.evidenceIds, marginKpi.current.evidenceIds)
    anomalies = [{
      kind: 'FACT',
      statement: 'Net sales increased during a merchant-sponsored price discount while contribution rate decreased.',
      evidenceIds: uniqueEvidenceIds(salesEvidence, marginEvidence, promotionEvidence),
    }]
    hypotheses = [buildHypothesis({
      statement: 'The promotion mix is associated with volume growth and contribution-rate compression in the same comparison window.',
      supportingEvidenceIds: uniqueEvidenceIds(salesEvidence, marginEvidence, promotionEvidence),
      limitations: ['No advertising attribution records are available for this SKU.', 'Incrementality is not measured by the fixture dataset.'],
      missingCriticalData: true,
    })]
    summary = { statement: 'Promotion-period growth coincides with weaker contribution economics.', evidenceIds: uniqueEvidenceIds(salesEvidence, marginEvidence, promotionEvidence) }
    recommendations = [{
      recommendationId: 'rec-promotion-adjustment',
      kind: 'RECOMMENDATION',
      action: 'Model a narrower discount proposal and require a contribution-rate floor before review.',
      rationale: 'The current promotion window has higher sales but lower contribution rate.',
      riskLevel: 'MEDIUM',
      evidenceIds: uniqueEvidenceIds(salesEvidence, marginEvidence, promotionEvidence),
      actionDraft: {
        actionType: 'CREATE_PROMOTION_TICKET',
        targetId: promotions.data[0]?.promotionId ?? definition.skuId,
        parameters: { contributionRateFloor: 0.2, skuId: definition.skuId },
        preconditions: ['Contribution-rate calculation is still valid at review time.'],
        expectedImpact: 'Request a promotion configuration review with an explicit contribution-rate floor.',
        rollbackPlan: 'Close the mock ticket without changing the promotion.',
      },
    }]
  } else if (route === 'AD_EFFICIENCY') {
    const spendKpi = metricKpi('ad_spend', baselineAds.data.metrics.spendMinor, currentAds.data.metrics.spendMinor)
    const ctrKpi = metricKpi('ad_ctr', baselineAds.data.metrics.ctr, currentAds.data.metrics.ctr)
    const cvrKpi = metricKpi('ad_cvr', baselineAds.data.metrics.cvr, currentAds.data.metrics.cvr)
    const cpcKpi = metricKpi('ad_cpc', baselineAds.data.metrics.cpcMinor, currentAds.data.metrics.cpcMinor)
    const roasKpi = metricKpi('ad_roas', baselineAds.data.metrics.roas, currentAds.data.metrics.roas)
    kpis = [...kpis, spendKpi, ctrKpi, cvrKpi, cpcKpi, roasKpi]
    const adEvidence = [...new Set([...baselineAds.evidence, ...currentAds.evidence].map(item => item.evidenceId))]
    const attributionMismatch = currentAds.data.metrics.attributionWindowDays.value !== 7
    const adSignal = diagnoseAdvertising({
      attributionAvailable: baselineAds.status !== 'missing' && currentAds.status !== 'missing',
      attributionAligned: !attributionMismatch,
      baselineSpend: baselineAds.data.metrics.spendMinor.value,
      currentSpend: currentAds.data.metrics.spendMinor.value,
      baselineClicks: baselineAds.data.metrics.clicks.value,
      currentClicks: currentAds.data.metrics.clicks.value,
      baselineCvr: baselineAds.data.metrics.cvr.value,
      currentCvr: currentAds.data.metrics.cvr.value,
      baselineSales: baselineSales.data.metrics.netSalesMinor.value,
      currentSales: currentSales.data.metrics.netSalesMinor.value,
      inventoryConstrained: currentInventory.data.metrics.stockoutSkuCount.value > 0,
    })
    anomalies = [{
      kind: 'FACT',
      statement: 'Advertising spend increased while attributed conversion rate, ROAS, and net sales decreased.',
      evidenceIds: uniqueEvidenceIds(salesEvidence, adEvidence),
    }]
    hypotheses = [buildHypothesis({
      statement: `${adSignal.statement} This signal is associated with the lower sales outcome in the current window.`,
      supportingEvidenceIds: uniqueEvidenceIds(salesEvidence, adEvidence),
      limitations: ['Attributed orders are not equivalent to total orders.', 'The comparison does not identify natural-traffic sessions.'],
      hasConflict: attributionMismatch,
      missingCriticalData: adSignal.missingCriticalData,
    })]
    summary = { statement: 'Higher ad spend coincides with weaker attributed efficiency and lower net sales.', evidenceIds: uniqueEvidenceIds(salesEvidence, adEvidence) }
    recommendations = [{
      recommendationId: 'rec-ad-budget-review',
      kind: 'RECOMMENDATION',
      action: 'Prepare a campaign-level budget review proposal and inspect search terms and audience segments.',
      rationale: 'Spend rose while CVR and ROAS declined in the aligned window.',
      riskLevel: 'MEDIUM',
      evidenceIds: uniqueEvidenceIds(salesEvidence, adEvidence),
      actionDraft: {
        actionType: 'ADJUST_AD_BUDGET',
        targetId: 'CAMPAIGN-C',
        parameters: { newBudgetMinor: 30000, currency: 'CNY', expectedVersion: 1 },
        preconditions: ['Campaign version remains 1.', 'The proposal receives an unexpired human approval.'],
        expectedImpact: 'Reduce the mock campaign budget while conversion efficiency is reviewed.',
        rollbackPlan: 'Restore the previous mock campaign budget using a separately approved proposal.',
      },
    }]
    if (attributionMismatch) {
      unknowns.push({ statement: 'Advertising attribution window is not aligned with the sales comparison window.', requiredData: 'Aligned attribution export or a sensitivity analysis across both windows.' })
    }
  } else {
    anomalies = [{ kind: 'FACT', statement: 'The available data does not identify a supported primary anomaly.', evidenceIds: salesEvidence }]
    hypotheses = [buildHypothesis({
      statement: 'Additional inventory, promotion, margin, or advertising evidence is required before selecting an explanation.',
      supportingEvidenceIds: salesEvidence,
      limitations: ['No deterministic diagnosis route matched the observed metrics.'],
      missingCriticalData: true,
    })]
    summary = { statement: 'The diagnosis remains unresolved because critical supporting data is unavailable.', evidenceIds: salesEvidence }
    recommendations = [{
      recommendationId: 'rec-collect-evidence',
      kind: 'RECOMMENDATION',
      action: 'Collect missing operating evidence before preparing a commercial proposal.',
      rationale: 'No supported diagnosis route matched the available metrics.',
      riskLevel: 'LOW',
      evidenceIds: salesEvidence,
      actionDraft: {
        actionType: 'CREATE_PROMOTION_TICKET',
        targetId: definition.skuId,
        parameters: { evidenceReviewOnly: true },
        preconditions: ['Missing evidence is collected.'],
        expectedImpact: 'Create a mock review ticket without changing business settings.',
        rollbackPlan: 'Close the mock review ticket.',
      },
    }]
    unknowns.push({ statement: 'No primary diagnosis route matched.', requiredData: 'Aligned inventory, promotion, cost, and advertising evidence.' })
  }

  const adsMissing = baselineAds.status === 'missing' || currentAds.status === 'missing'
  if (adsMissing) {
    unknowns.push({
      statement: 'Advertising attribution data is missing for at least one comparison window.',
      requiredData: 'SKU-level impressions, clicks, spend, attributed orders, revenue, and attribution-window definition.',
    })
    risks.push('Advertising effects cannot be separated from organic demand with the available evidence.')
  }

  const withoutEvidence: Omit<DiagnosisReportDraft, 'evidence'> = {
    traceId: definition.traceId,
    caseId: caseName,
    generatedAt: GENERATED_AT,
    status: adsMissing || unknowns.length > 0 ? 'NEEDS_DATA' : 'RESOLVED',
    scope: {
      shopId: 'demo-shop',
      skuIds: [definition.skuId],
      baselineWindow: BASELINE_WINDOW,
      currentWindow: CURRENT_WINDOW,
      currency: 'CNY',
    },
    executiveSummary: summary,
    kpis,
    anomalies,
    hypotheses,
    risks,
    unknowns,
    recommendations,
  }
  const evidenceList = referencedEvidenceIds(withoutEvidence).map(evidenceId => {
    const record = evidence.getOrThrow(evidenceId)
    return { evidenceId, source: record.source, asOf: record.asOf, summary: record.summary }
  })
  return await validateAndPersistReport({ ...withoutEvidence, evidence: evidenceList }, evidence, reports)
  } finally {
    store.close()
  }
}

export function defaultWorkflowPaths(): { fixtureDir: string; reportDir: string; dbPath: string } {
  return {
    fixtureDir: resolve(import.meta.dir, '../../fixtures'),
    reportDir: resolve(import.meta.dir, '../../demo/artifacts'),
    dbPath: resolve(import.meta.dir, '../../demo/artifacts/commerce.sqlite'),
  }
}
