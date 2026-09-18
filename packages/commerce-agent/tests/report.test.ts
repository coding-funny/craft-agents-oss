import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { ReportRepository } from '../src/reports/report-repository.ts'
import type { DiagnosisReportDraft } from '../src/reports/schema.ts'
import { validateAndPersistReport } from '../src/reports/validate-report.ts'
import { BASELINE_WINDOW, createFixtureHarness, CURRENT_WINDOW, queryFor } from './helpers.ts'

const temporaryDirectories: string[] = []

function reportDir(): string {
  const path = mkdtempSync(resolve(tmpdir(), 'commerce-report-'))
  temporaryDirectories.push(path)
  return path
}

async function createHarness() {
  const { evidence, adapter } = createFixtureHarness()
  const baselineResult = await adapter.querySales(queryFor(['SKU-A'], BASELINE_WINDOW, 'trace-report-001'))
  const currentResult = await adapter.querySales(queryFor(['SKU-A'], CURRENT_WINDOW, 'trace-report-001'))
  const baseline = baselineResult.evidence[0]!
  const current = currentResult.evidence[0]!
  const draft: DiagnosisReportDraft = {
    traceId: 'trace-report-001',
    caseId: 'case-report-001',
    generatedAt: '2026-09-15T09:00:00+08:00',
    status: 'UNRESOLVED',
    scope: {
      shopId: 'demo-shop',
      skuIds: ['SKU-A'],
      baselineWindow: BASELINE_WINDOW,
      currentWindow: CURRENT_WINDOW,
      currency: 'CNY',
    },
    executiveSummary: { statement: 'Current net sales are below baseline.', evidenceIds: [baseline.evidenceId, current.evidenceId] },
    kpis: [{
      name: 'net_sales',
      baseline: { value: 200000, unit: 'CNY_minor', evidenceIds: [baseline.evidenceId] },
      current: { value: 110000, unit: 'CNY_minor', evidenceIds: [current.evidenceId] },
      changeRate: -0.45,
    }],
    anomalies: [{ kind: 'FACT', statement: 'Current net sales are 45% below baseline.', evidenceIds: [baseline.evidenceId, current.evidenceId] }],
    hypotheses: [{
      kind: 'HYPOTHESIS',
      statement: 'Additional inventory and traffic evidence is needed to explain the change.',
      confidence: 'LOW',
      confidenceScore: 0.4,
      supportingEvidenceIds: [baseline.evidenceId, current.evidenceId],
      counterEvidenceIds: [],
      limitations: ['Sales records alone do not identify a root cause.'],
    }],
    evidence: [baseline.evidenceId, current.evidenceId].map(evidenceId => {
      const record = evidence.getOrThrow(evidenceId)
      return { evidenceId, source: record.source, asOf: record.asOf, summary: record.summary }
    }),
    risks: ['A decision based only on sales records may be incomplete.'],
    unknowns: [],
    recommendations: [{
      recommendationId: 'rec-collect-data',
      kind: 'RECOMMENDATION',
      action: 'Collect inventory and advertising evidence before drafting an intervention.',
      rationale: 'The present evidence only establishes the sales change.',
      riskLevel: 'LOW',
      evidenceIds: [baseline.evidenceId, current.evidenceId],
      actionDraft: {
        actionType: 'CREATE_REPLENISHMENT_TASK',
        targetId: 'SKU-A',
        parameters: { requestedQty: 10 },
        preconditions: ['Inventory evidence is collected.'],
        expectedImpact: 'Create a reviewable mock task.',
        rollbackPlan: 'Cancel the mock task.',
      },
    }],
  }
  return { evidence, baseline, current, draft }
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('report quality gate', () => {
  it('persists and reads back a validated Artifact by report ID', async () => {
    const { evidence, draft } = await createHarness()
    const repository = new ReportRepository(reportDir())
    const persisted = await validateAndPersistReport(draft, evidence, repository)
    expect(await repository.get(persisted.report.reportId)).toEqual(persisted.report)
  })

  it('rejects a report whose evidence list omits a referenced ID', async () => {
    const { evidence, draft } = await createHarness()
    const invalid = { ...draft, evidence: draft.evidence.slice(0, 1) }
    await expect(validateAndPersistReport(invalid, evidence, new ReportRepository(reportDir())))
      .rejects.toThrow('missing from report evidence list')
  })

  it('rejects a well-formed but nonexistent evidence ID', async () => {
    const { evidence, draft } = await createHarness()
    const missing = 'ev_0123456789abcdef01234567'
    const invalid = {
      ...draft,
      executiveSummary: { ...draft.executiveSummary, evidenceIds: [...draft.executiveSummary.evidenceIds, missing] },
      evidence: [...draft.evidence, {
        evidenceId: missing,
        source: 'fixture-v1/missing.json',
        asOf: draft.generatedAt,
        summary: 'missing evidence',
      }],
    }
    await expect(validateAndPersistReport(invalid, evidence, new ReportRepository(reportDir())))
      .rejects.toThrow('Evidence cannot be resolved')
  })

  it('rejects report currency and evidence time-window conflicts', async () => {
    const currencyHarness = await createHarness()
    const wrongCurrency = {
      ...currencyHarness.draft,
      kpis: currencyHarness.draft.kpis.map(kpi => ({
        ...kpi,
        baseline: { ...kpi.baseline, unit: 'USD_minor' },
        current: { ...kpi.current, unit: 'USD_minor' },
      })),
    }
    await expect(validateAndPersistReport(wrongCurrency, currencyHarness.evidence, new ReportRepository(reportDir())))
      .rejects.toThrow('KPI currency conflicts')

    const timeHarness = await createHarness()
    const wrongWindow = {
      ...timeHarness.draft,
      scope: {
        ...timeHarness.draft.scope,
        currentWindow: { ...CURRENT_WINDOW, end: '2026-09-16T00:00:00+08:00' },
      },
    }
    await expect(validateAndPersistReport(wrongWindow, timeHarness.evidence, new ReportRepository(reportDir())))
      .rejects.toThrow('Evidence time window conflicts')
  })

  it('rejects unsupported causal certainty and executed-action claims', async () => {
    const certaintyHarness = await createHarness()
    const certain = {
      ...certaintyHarness.draft,
      hypotheses: certaintyHarness.draft.hypotheses.map(item => ({ ...item, statement: 'Inventory definitely caused the decline.' })),
    }
    await expect(validateAndPersistReport(certain, certaintyHarness.evidence, new ReportRepository(reportDir())))
      .rejects.toThrow('unsupported certainty')

    const executionHarness = await createHarness()
    const executed = {
      ...executionHarness.draft,
      recommendations: executionHarness.draft.recommendations.map(item => ({ ...item, action: 'Executed budget reduction.' })),
    }
    await expect(validateAndPersistReport(executed, executionHarness.evidence, new ReportRepository(reportDir())))
      .rejects.toThrow('cannot claim an action was executed')
  })

  it('rejects KPI values and period references that do not match evidence', async () => {
    const valueHarness = await createHarness()
    const wrongValue = structuredClone(valueHarness.draft)
    wrongValue.kpis[0]!.current.value = 999999999
    wrongValue.kpis[0]!.changeRate = 12345
    await expect(validateAndPersistReport(wrongValue, valueHarness.evidence, new ReportRepository(reportDir())))
      .rejects.toThrow('KPI value does not match evidence')

    const periodHarness = await createHarness()
    const wrongPeriod = structuredClone(periodHarness.draft)
    const baselineIds = wrongPeriod.kpis[0]!.baseline.evidenceIds
    wrongPeriod.kpis[0]!.baseline.evidenceIds = wrongPeriod.kpis[0]!.current.evidenceIds
    wrongPeriod.kpis[0]!.current.evidenceIds = baselineIds
    await expect(validateAndPersistReport(wrongPeriod, periodHarness.evidence, new ReportRepository(reportDir())))
      .rejects.toThrow('wrong comparison period')
  })

  it('rejects action drafts whose parameters do not match the action type', async () => {
    const { evidence, draft } = await createHarness()
    const invalid = structuredClone(draft)
    invalid.recommendations[0]!.actionDraft.actionType = 'ADJUST_AD_BUDGET'
    await expect(validateAndPersistReport(invalid, evidence, new ReportRepository(reportDir())))
      .rejects.toThrow('ADJUST_AD_BUDGET requires')
  })
})
