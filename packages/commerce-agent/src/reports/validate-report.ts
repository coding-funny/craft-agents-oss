import { CommerceError } from '../domain/errors.ts'
import type { EvidenceRecord } from '../domain/contracts.ts'
import {
  AdRecordArraySchema,
  InventorySnapshotArraySchema,
  ProductRecordArraySchema,
  SalesRecordArraySchema,
  type EvidenceRef,
  type TimeRange,
} from '../domain/contracts.ts'
import type { EvidenceRepository } from '../evidence/evidence-repository.ts'
import { evidenceSetHealth } from '../evidence/freshness-policy.ts'
import { calculateAdMetrics } from '../metrics/ads.ts'
import { calculateInventoryMetrics } from '../metrics/inventory.ts'
import { calculateMarginMetrics } from '../metrics/margin.ts'
import { calculateSalesMetrics } from '../metrics/sales.ts'
import { createReportId, type PersistedReport, type ReportRepository } from './report-repository.ts'
import { renderReport } from './render-report.ts'
import {
  DiagnosisReportDraftSchema,
  type DiagnosisReportDraft,
  type ReportScope,
} from './schema.ts'

const UNSUPPORTED_CERTAINTY = /(?:必然|完全证明|确定由|唯一原因|\b(?:definitely|certainly|proves?|caused by)\b)/i

function fail(message: string, details?: Record<string, unknown>): never {
  throw new CommerceError('INVALID_ARGUMENT', message, details)
}

function sameWindow(left: unknown, right: ReportScope['currentWindow']): boolean {
  if (!left || typeof left !== 'object') return false
  const window = left as Record<string, unknown>
  return window.start === right.start && window.end === right.end && window.timezone === right.timezone
}

function sameBusinessWindow(left: { start: string; end: string }, right: ReportScope['currentWindow']): boolean {
  return left.start === right.start && left.end === right.end
}

function collectReferencedEvidence(report: DiagnosisReportDraft): Set<string> {
  return new Set([
    ...report.executiveSummary.evidenceIds,
    ...report.kpis.flatMap(kpi => [...kpi.baseline.evidenceIds, ...kpi.current.evidenceIds]),
    ...report.anomalies.flatMap(item => item.evidenceIds),
    ...report.hypotheses.flatMap(item => [...item.supportingEvidenceIds, ...item.counterEvidenceIds]),
    ...report.recommendations.flatMap(item => item.evidenceIds),
  ])
}

function assertEvidenceScope(record: EvidenceRecord, report: DiagnosisReportDraft): void {
  const query = record.query
  if (query.shopId !== report.scope.shopId || query.currency !== report.scope.currency) {
    fail(`Evidence scope conflicts with report scope: ${record.evidenceId}`)
  }
  const skuIds = query.skuIds
  if (!Array.isArray(skuIds) || skuIds.some(value => typeof value !== 'string' || !report.scope.skuIds.includes(value))) {
    fail(`Evidence SKU scope conflicts with report scope: ${record.evidenceId}`)
  }
  if (!sameWindow(query.window, report.scope.baselineWindow) && !sameWindow(query.window, report.scope.currentWindow)) {
    fail(`Evidence time window conflicts with report scope: ${record.evidenceId}`)
  }
}

function assertMetricConsistency(report: DiagnosisReportDraft): void {
  for (const kpi of report.kpis) {
    if (kpi.baseline.unit !== kpi.current.unit) fail(`KPI unit conflict: ${kpi.name}`)
    if (kpi.baseline.unit.includes('_minor') && !kpi.baseline.unit.startsWith(`${report.scope.currency}_minor`)) {
      fail(`KPI currency conflicts with report scope: ${kpi.name}`)
    }
  }
}

function assertGovernedReportEvidence(records: EvidenceRecord[], report: DiagnosisReportDraft): void {
  if (!records.some(record => record.governance)) return
  if (records.some(record => !record.governance)) fail('Report cannot mix governed and legacy evidence')
  const health = evidenceSetHealth(records)
  if (health.health === 'CONFLICT') fail('Report evidence has a scope or snapshot conflict', { reasons: health.reasons })
  const metricVersions = new Set(records.map(record => record.governance!.metricDefinitionVersion))
  if (metricVersions.size !== 1) fail('Report evidence mixes metric definition versions')
  for (const record of records) {
    if (record.governance!.shopId !== report.scope.shopId) {
      fail(`Governed evidence shop conflicts with report scope: ${record.evidenceId}`)
    }
    if (!sameBusinessWindow(record.governance!.businessTimeRange, report.scope.baselineWindow)
      && !sameBusinessWindow(record.governance!.businessTimeRange, report.scope.currentWindow)) {
      fail(`Governed evidence business window conflicts with report scope: ${record.evidenceId}`)
    }
  }
}

type MetricSnapshot = DiagnosisReportDraft['kpis'][number]['baseline']

function sameMetricValue(left: number | null, right: number | null): boolean {
  if (left === null || right === null) return left === right
  return Math.abs(left - right) < 1e-9
}

function metricEvidenceRefs(records: EvidenceRecord[], traceId: string): EvidenceRef[] {
  return records.map(record => ({
    evidenceId: record.evidenceId,
    source: record.source,
    locator: record.recordRefs.join(',') || 'empty-result',
    traceId,
  }))
}

function deriveMetric(
  name: string,
  records: EvidenceRecord[],
  window: TimeRange,
  traceId: string,
): { value: number | null; unit: string } {
  const refs = metricEvidenceRefs(records, traceId)
  const salesRecords = records
    .filter(record => record.tool === 'query_sales')
    .flatMap(record => SalesRecordArraySchema.parse(record.content))
  const salesEvidence = metricEvidenceRefs(records.filter(record => record.tool === 'query_sales'), traceId)
  const sales = calculateSalesMetrics(salesRecords, window, salesEvidence.length > 0 ? salesEvidence : refs)
  if (name === 'net_sales') return sales.netSalesMinor

  if (name === 'stockout_sku_count') {
    const inventoryRecords = records
      .filter(record => record.tool === 'query_inventory')
      .flatMap(record => InventorySnapshotArraySchema.parse(record.content))
    return calculateInventoryMetrics(inventoryRecords, sales, window, refs).stockoutSkuCount
  }

  if (name === 'contribution_rate') {
    const products = records
      .filter(record => record.tool === 'query_products')
      .flatMap(record => ProductRecordArraySchema.parse(record.content))
    return calculateMarginMetrics(salesRecords, products, window, refs).contributionRate
  }

  const adsRecords = records
    .filter(record => record.tool === 'query_ads')
    .flatMap(record => AdRecordArraySchema.parse(record.content))
  const ads = calculateAdMetrics(adsRecords, refs)
  const adMetric = {
    ad_spend: ads.spendMinor,
    ad_ctr: ads.ctr,
    ad_cvr: ads.cvr,
    ad_cpc: ads.cpcMinor,
    ad_roas: ads.roas,
  }[name]
  if (!adMetric) fail(`Unsupported KPI for evidence recomputation: ${name}`)
  return adMetric
}

function assertMetricSnapshot(
  kpiName: string,
  snapshot: MetricSnapshot,
  window: TimeRange,
  report: DiagnosisReportDraft,
  evidenceRepository: EvidenceRepository,
): void {
  const records = snapshot.evidenceIds.map(evidenceId => evidenceRepository.getOrThrow(evidenceId))
  if (records.some(record => !sameWindow(record.query.window, window))) {
    fail(`KPI evidence is assigned to the wrong comparison period: ${kpiName}`)
  }
  const derived = deriveMetric(kpiName, records, window, report.traceId)
  if (derived.unit !== snapshot.unit || !sameMetricValue(derived.value, snapshot.value)) {
    fail(`KPI value does not match evidence: ${kpiName}`, { expected: derived, received: snapshot })
  }
}

function assertKpiValues(report: DiagnosisReportDraft, evidenceRepository: EvidenceRepository): void {
  for (const kpi of report.kpis) {
    assertMetricSnapshot(kpi.name, kpi.baseline, report.scope.baselineWindow, report, evidenceRepository)
    assertMetricSnapshot(kpi.name, kpi.current, report.scope.currentWindow, report, evidenceRepository)
    const expectedChange = kpi.baseline.value === null || kpi.current.value === null || kpi.baseline.value === 0
      ? null
      : Math.round(((kpi.current.value - kpi.baseline.value) / kpi.baseline.value) * 10_000) / 10_000
    if (!sameMetricValue(expectedChange, kpi.changeRate)) fail(`KPI change rate does not match values: ${kpi.name}`)
  }
}

function assertLanguageSafety(report: DiagnosisReportDraft): void {
  const claims = [
    report.executiveSummary.statement,
    ...report.anomalies.map(item => item.statement),
    ...report.hypotheses.map(item => item.statement),
  ]
  const unsupported = claims.find(claim => UNSUPPORTED_CERTAINTY.test(claim))
  if (unsupported) fail('Report contains unsupported certainty language', { statement: unsupported })
  for (const recommendation of report.recommendations) {
    if (recommendation.kind !== 'RECOMMENDATION') fail('Facts and recommendations must be separated')
    if (/(?:已执行|executed|applied change)/i.test(recommendation.action)) {
      fail('Report recommendations cannot claim an action was executed')
    }
  }
}

export async function validateAndPersistReport(
  input: unknown,
  evidenceRepository: EvidenceRepository,
  reportRepository: ReportRepository,
): Promise<PersistedReport> {
  const report = DiagnosisReportDraftSchema.parse(input)
  const referenced = collectReferencedEvidence(report)
  const referencedRecords: EvidenceRecord[] = []
  const listed = new Map(report.evidence.map(item => [item.evidenceId, item]))
  if (listed.size !== report.evidence.length) fail('Evidence list contains duplicate IDs')
  if (referenced.size === 0) fail('Report does not reference evidence')
  for (const evidenceId of referenced) {
    const listedEvidence = listed.get(evidenceId)
    if (!listedEvidence) fail(`Referenced evidence is missing from report evidence list: ${evidenceId}`)
    const record = evidenceRepository.get(evidenceId)
    if (!record) fail(`Evidence cannot be resolved: ${evidenceId}`)
    assertEvidenceScope(record, report)
    referencedRecords.push(record)
    if (record.source !== listedEvidence.source || record.asOf !== listedEvidence.asOf) {
      fail(`Evidence metadata does not match repository: ${evidenceId}`)
    }
  }
  for (const evidenceId of listed.keys()) {
    if (!referenced.has(evidenceId)) fail(`Evidence is listed but not referenced: ${evidenceId}`)
  }
  assertMetricConsistency(report)
  assertGovernedReportEvidence(referencedRecords, report)
  assertKpiValues(report, evidenceRepository)
  assertLanguageSafety(report)
  const reportId = createReportId(report)
  return reportRepository.save(report, renderReport(report, reportId))
}
