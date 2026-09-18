import { describe, expect, it } from 'bun:test'
import { MonitorRepository } from '../../src/monitoring/repository.ts'
import { MonitorService } from '../../src/monitoring/service.ts'
import { CommerceDatabase } from '../../src/storage/database.ts'

const config = {
  ruleVersion: 'ops-rules-v1', cooldownMs: 86_400_000, maxNewCasesPerScan: 10,
  ads: { minimumSpendMinor: 10_000, minimumClicks: 100, cvrDropRatio: 0.3 },
  inventory: { minimumBaselineSales: 20, salesDropRatio: 0.3, lowStockUnits: 5 },
}
const fields = ['salesUnits', 'stockUnits', 'adSpendMinor', 'adClicks', 'adConversions', 'adRevenueMinor']
const metrics = { salesUnits: 100, stockUnits: 50, adSpendMinor: 20_000, adClicks: 1_000, adConversions: 100, adRevenueMinor: 100_000 }

function scan(snapshotId = 'snapshot-1', entities: any[] = [
  { entityType: 'CAMPAIGN', entityId: 'campaign-a', baseline: metrics, current: { ...metrics, adConversions: 50 }, completeFields: fields, promotionActive: false, holidayHint: false },
  { entityType: 'SKU', entityId: 'sku-a', baseline: metrics, current: { ...metrics, salesUnits: 50, stockUnits: 0 }, completeFields: fields, promotionActive: true, holidayHint: false },
]) { return { tenantId: 'tenant-a', shopId: 'shop-a', snapshotId, window: { start: '2026-09-10T00:00:00Z', end: '2026-09-17T00:00:00Z' }, entities } }

describe('deterministic monitor and cooldown governance', () => {
  it('detects ads and inventory symptoms without claiming causality', () => {
    const store = new CommerceDatabase(':memory:'); const service = new MonitorService(new MonitorRepository(store), () => new Date('2026-09-17T01:00:00Z'))
    const result = service.scan(scan(), config)
    expect(result.newCases).toBe(2)
    expect(result.detections.map(item => item.detection.anomalyType)).toEqual(['ADS_EFFICIENCY', 'SALES_INVENTORY'])
    expect(result.detections.every(item => /causal|causality/.test(item.detection.reason))).toBe(true)
  })

  it('deduplicates the same snapshot and merges revisions during cooldown', () => {
    const store = new CommerceDatabase(':memory:'); const repository = new MonitorRepository(store); const service = new MonitorService(repository, () => new Date('2026-09-17T01:00:00Z'))
    const first = service.scan(scan(), config); const duplicate = service.scan(scan(), config); const revision = service.scan(scan('snapshot-2'), config)
    expect(duplicate.detections.every(item => item.outcome === 'DUPLICATE')).toBe(true)
    expect(revision.detections.every(item => item.outcome === 'MERGED')).toBe(true)
    expect(repository.list({ tenantId: 'tenant-a', shopIds: ['shop-a'] })).toHaveLength(2)
    expect(first.detections[0]?.case?.caseId).toBe(revision.detections[0]?.case?.caseId)
  })

  it('defers incomplete data and applies a per-scan new-case quota', () => {
    const store = new CommerceDatabase(':memory:'); const service = new MonitorService(new MonitorRepository(store))
    const incomplete = { entityType: 'SKU', entityId: 'sku-missing', baseline: metrics, current: metrics, completeFields: ['salesUnits'], promotionActive: false, holidayHint: false }
    const quota = { ...config, maxNewCasesPerScan: 1 }
    const result = service.scan(scan('snapshot-q', [incomplete, { ...incomplete, entityId: 'sku-missing-2' }]), quota)
    expect(result.detections[0]?.detection.anomalyType).toBe('DATA_INCOMPLETE')
    expect(result.detections[0]?.case?.status).toBe('DEFERRED')
    expect(result.detections[1]?.outcome).toBe('QUOTA_SUPPRESSED')
  })

  it('does not detect ads below the minimum sample size', () => {
    const store = new CommerceDatabase(':memory:'); const service = new MonitorService(new MonitorRepository(store))
    const lowSample = { entityType: 'CAMPAIGN', entityId: 'campaign-low', baseline: metrics, current: { ...metrics, adClicks: 20, adConversions: 0 }, completeFields: fields, promotionActive: false, holidayHint: false }
    expect(service.scan(scan('snapshot-low', [lowSample]), config).detections).toHaveLength(0)
  })
})
