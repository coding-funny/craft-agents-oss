import type { EvidenceRef, InventorySnapshot, MetricValue, TimeRange } from '../domain/contracts.ts'
import { deduplicateBy, durationDays, mergeEvidence, metric, ratio, sumSafe } from './common.ts'
import type { SalesMetrics } from './sales.ts'

export type InventoryMetrics = {
  latestAvailableQty: MetricValue<number>
  stockoutSkuCount: MetricValue<number>
  averageDailyUnits: MetricValue<number>
  coverageDays: MetricValue<number | null>
  potentialLostSalesMinor: MetricValue<number>
}

export function calculateInventoryMetrics(
  input: InventorySnapshot[],
  sales: SalesMetrics,
  window: TimeRange,
  inventoryEvidence: EvidenceRef[],
): InventoryMetrics {
  const snapshots = deduplicateBy(input, row => row.snapshotId)
  const days = durationDays(window.start, window.end)
  const latestBySku = new Map<string, InventorySnapshot>()
  for (const snapshot of snapshots) {
    const current = latestBySku.get(snapshot.skuId)
    if (!current || Date.parse(snapshot.observedAt) > Date.parse(current.observedAt)) {
      latestBySku.set(snapshot.skuId, snapshot)
    }
  }
  const latestAvailableQty = sumSafe(
    [...latestBySku.values()].map(snapshot => snapshot.availableQty),
    'available inventory',
  )
  const stockoutSkus = new Set(snapshots.filter(snapshot => snapshot.availableQty === 0).map(snapshot => snapshot.skuId))
  const zeroSnapshotDays = new Set(snapshots
    .filter(snapshot => snapshot.availableQty === 0)
    .map(snapshot => `${snapshot.skuId}:${snapshot.observedAt.slice(0, 10)}`))
  const averageDailyUnits = Math.round((sales.unitsSold.value / days) * 10_000) / 10_000
  const averageDailyNetSales = sales.netSalesMinor.value / days
  const potentialLostSalesMinor = Math.round(zeroSnapshotDays.size * averageDailyNetSales)
  const evidence = mergeEvidence(inventoryEvidence, sales.unitsSold.evidence, sales.netSalesMinor.evidence)

  return {
    latestAvailableQty: metric(latestAvailableQty, 'units', inventoryEvidence),
    stockoutSkuCount: metric(stockoutSkus.size, 'skus', inventoryEvidence),
    averageDailyUnits: metric(averageDailyUnits, 'units_per_day', sales.unitsSold.evidence),
    coverageDays: metric(ratio(latestAvailableQty, averageDailyUnits), 'days', evidence),
    potentialLostSalesMinor: metric(
      potentialLostSalesMinor,
      sales.currency ? `${sales.currency}_minor` : 'money_minor',
      evidence,
    ),
  }
}
