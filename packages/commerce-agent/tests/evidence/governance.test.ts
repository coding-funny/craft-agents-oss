import { describe, expect, it } from 'bun:test'
import { EvidenceRepository } from '../../src/evidence/evidence-repository.ts'
import { evaluateSnapshotHealth, evidenceSetHealth } from '../../src/evidence/freshness-policy.ts'
import { reviewReportClaims, type SemanticReviewer } from '../../src/reports/semantic-review.ts'
import type { DiagnosisReportDraft } from '../../src/reports/schema.ts'

const WINDOW = {
  start: '2026-09-08T00:00:00+08:00',
  end: '2026-09-15T00:00:00+08:00',
  timezone: 'Asia/Shanghai',
}

function capture(repository: EvidenceRepository, snapshotId: string, shopId = 'demo-shop') {
  return repository.capture({
    tool: 'query_sales',
    source: `import:test:snapshot:${snapshotId}`,
    asOf: '2026-09-15T09:00:00+08:00',
    traceId: 'trace-review',
    query: { shopId, skuIds: ['SKU-A'], window: WINDOW, currency: 'CNY' },
    recordRefs: ['record_000000000000000000000001'],
    content: [{ lineId: 'line-1' }],
    summary: 'governed sales evidence',
    governance: {
      schemaVersion: 2,
      tenantId: 'demo-tenant',
      shopId,
      snapshotId,
      sourceType: 'SYNTHETIC_FIXTURE',
      sourceRecordIds: ['line-1'],
      metricDefinitionVersion: 'metrics-v1',
      contentHash: '0'.repeat(64),
      businessTimeRange: { start: WINDOW.start, end: WINDOW.end },
      ingestedAt: '2026-09-15T09:00:00+08:00',
    },
  })
}

function report(evidenceIds: string[]): DiagnosisReportDraft {
  return {
    traceId: 'trace-review',
    caseId: 'case-review',
    generatedAt: '2026-09-15T09:00:00+08:00',
    status: 'UNRESOLVED',
    scope: { shopId: 'demo-shop', skuIds: ['SKU-A'], baselineWindow: WINDOW, currentWindow: WINDOW, currency: 'CNY' },
    executiveSummary: { statement: 'Advertising caused sales to increase.', evidenceIds },
    kpis: [],
    anomalies: [],
    hypotheses: [],
    evidence: [],
    risks: [],
    unknowns: [],
    recommendations: [],
  }
}

describe('evidence governance and semantic review', () => {
  it('keeps semantic review pending when no reviewer is configured', async () => {
    const evidence = new EvidenceRepository()
    const ref = capture(evidence, 'snapshot_000000000000000000000001')
    const result = await reviewReportClaims({
      report: report([ref.evidenceId]), tenantId: 'demo-tenant', evidenceRepository: evidence,
    })
    expect(result.status).toBe('PENDING_REVIEW')
    expect(result.reviews[0]?.verdict).toBe('PENDING_REVIEW')
  })

  it('records a reviewer contradiction rather than treating citation presence as support', async () => {
    const evidence = new EvidenceRepository()
    const ref = capture(evidence, 'snapshot_000000000000000000000001')
    const reviewer: SemanticReviewer = {
      describe: () => ({ kind: 'external', version: 'test-reviewer-v1' }),
      review: async () => ({ verdict: 'CONTRADICTED', reasons: ['sales evidence does not establish advertising causality'] }),
    }
    const result = await reviewReportClaims({
      report: report([ref.evidenceId]), tenantId: 'demo-tenant', evidenceRepository: evidence, reviewer,
    })
    expect(result.status).toBe('REVIEWED')
    expect(result.reviews[0]?.verdict).toBe('CONTRADICTED')
  })

  it('hard-rejects cross-snapshot evidence before semantic review', async () => {
    const evidence = new EvidenceRepository()
    const first = capture(evidence, 'snapshot_000000000000000000000001')
    const second = capture(evidence, 'snapshot_000000000000000000000002')
    await expect(reviewReportClaims({
      report: report([first.evidenceId, second.evidenceId]),
      tenantId: 'demo-tenant',
      evidenceRepository: evidence,
    })).rejects.toThrow('internally inconsistent')
  })

  it('reports incomplete and stale snapshots without converting missing data to zero', () => {
    const snapshot = {
      snapshotId: 'snapshot_000000000000000000000001', tenantId: 'demo-tenant', shopId: 'demo-shop',
      sourceType: 'SYNTHETIC_FIXTURE' as const, sourceId: 'test-source', currency: 'CNY', timezone: 'Asia/Shanghai',
      asOf: '2026-09-15T09:00:00+08:00', importId: 'import_000000000000000000000001', recordVersionIds: [],
      completeness: { sales: 'complete' as const, inventory: 'missing' as const, promotions: 'complete' as const,
        products: 'complete' as const, ads: 'complete' as const },
      metricDefinitionVersion: 'metrics-v1', createdAt: '2026-09-15T09:00:00+08:00',
    }
    const result = evaluateSnapshotHealth(snapshot, '2026-09-17T09:00:00+08:00')
    expect(result.health).toBe('INCOMPLETE')
    expect(result.byKind.inventory).toBe('INCOMPLETE')
    expect(result.byKind.sales).toBe('STALE')

    const repository = new EvidenceRepository()
    const governed = capture(repository, snapshot.snapshotId)
    expect(evidenceSetHealth([repository.getOrThrow(governed.evidenceId)]).health).toBe('FRESH')
  })
})
