import { resolve } from 'node:path'
import type { QueryContext, TimeRange } from '../src/domain/contracts.ts'
import { EvidenceRepository } from '../src/evidence/evidence-repository.ts'
import { FixtureAdapter } from '../src/adapters/fixture-adapter.ts'

export const BASELINE_WINDOW: TimeRange = {
  start: '2026-09-01T00:00:00+08:00',
  end: '2026-09-08T00:00:00+08:00',
  timezone: 'Asia/Shanghai',
}

export const CURRENT_WINDOW: TimeRange = {
  start: '2026-09-08T00:00:00+08:00',
  end: '2026-09-15T00:00:00+08:00',
  timezone: 'Asia/Shanghai',
}

export function queryFor(skuIds: string[], window = CURRENT_WINDOW, traceId = 'trace-test-001'): QueryContext {
  return {
    runId: 'run-test-001',
    caseId: 'case-test-001',
    traceId,
    shopId: 'demo-shop',
    skuIds,
    window,
    asOf: '2026-09-15T09:00:00+08:00',
    currency: 'CNY',
  }
}

export function createFixtureHarness(): { adapter: FixtureAdapter; evidence: EvidenceRepository } {
  const evidence = new EvidenceRepository()
  const adapter = new FixtureAdapter({
    fixtureDir: resolve(import.meta.dir, '../fixtures'),
    allowedShopId: 'demo-shop',
    evidence,
  })
  return { adapter, evidence }
}
