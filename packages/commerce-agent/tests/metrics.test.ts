import { describe, expect, it } from 'bun:test'
import type { AdRecord, SalesRecord } from '../src/domain/contracts.ts'
import { calculateAdMetrics } from '../src/metrics/ads.ts'
import { calculateInventoryMetrics } from '../src/metrics/inventory.ts'
import { calculateMarginMetrics } from '../src/metrics/margin.ts'
import { comparePromotionPerformance } from '../src/metrics/promotion.ts'
import { calculateSalesMetrics } from '../src/metrics/sales.ts'
import { BASELINE_WINDOW, createFixtureHarness, CURRENT_WINDOW, queryFor } from './helpers.ts'

describe('deterministic commerce metrics', () => {
  it('calculates the inventory-shortage case with refunds and cancellations', async () => {
    const { adapter } = createFixtureHarness()
    const [salesResult, inventoryResult] = await Promise.all([
      adapter.querySales(queryFor(['SKU-A'], CURRENT_WINDOW)),
      adapter.queryInventory(queryFor(['SKU-A'], CURRENT_WINDOW)),
    ])
    const sales = calculateSalesMetrics(salesResult.data, CURRENT_WINDOW, salesResult.evidence)
    const inventory = calculateInventoryMetrics(
      inventoryResult.data,
      sales,
      CURRENT_WINDOW,
      inventoryResult.evidence,
    )

    expect(sales.gmvMinor.value).toBe(120000)
    expect(sales.paidOrderCount.value).toBe(3)
    expect(sales.unitsSold.value).toBe(12)
    expect(sales.refundAmountMinor.value).toBe(10000)
    expect(sales.netSalesMinor.value).toBe(110000)
    expect(inventory.latestAvailableQty.value).toBe(0)
    expect(inventory.stockoutSkuCount.value).toBe(1)
    expect(inventory.coverageDays.value).toBe(0)
    expect(inventory.potentialLostSalesMinor.value).toBe(31429)
    expect(inventory.potentialLostSalesMinor.evidence.length).toBeGreaterThanOrEqual(2)
  })

  it('shows promotion volume growth while contribution rate falls', async () => {
    const { adapter } = createFixtureHarness()
    const [beforeSalesResult, duringSalesResult, beforeProducts, duringProducts, promotions] = await Promise.all([
      adapter.querySales(queryFor(['SKU-B'], BASELINE_WINDOW, 'trace-promo-before')),
      adapter.querySales(queryFor(['SKU-B'], CURRENT_WINDOW, 'trace-promo-during')),
      adapter.queryProducts(queryFor(['SKU-B'], BASELINE_WINDOW, 'trace-products-before')),
      adapter.queryProducts(queryFor(['SKU-B'], CURRENT_WINDOW, 'trace-products-during')),
      adapter.queryPromotions(queryFor(['SKU-B'], CURRENT_WINDOW, 'trace-promotions')),
    ])
    const beforeSales = calculateSalesMetrics(beforeSalesResult.data, BASELINE_WINDOW, beforeSalesResult.evidence)
    const duringSales = calculateSalesMetrics(duringSalesResult.data, CURRENT_WINDOW, duringSalesResult.evidence)
    const beforeMargin = calculateMarginMetrics(
      beforeSalesResult.data,
      beforeProducts.data,
      BASELINE_WINDOW,
      [...beforeSalesResult.evidence, ...beforeProducts.evidence],
    )
    const duringMargin = calculateMarginMetrics(
      duringSalesResult.data,
      duringProducts.data,
      CURRENT_WINDOW,
      [...duringSalesResult.evidence, ...duringProducts.evidence],
    )
    const comparison = comparePromotionPerformance(
      beforeSales,
      duringSales,
      beforeMargin,
      duringMargin,
      promotions.evidence,
    )

    expect(beforeMargin.contributionMinor.value).toBe(13000)
    expect(beforeMargin.contributionRate.value).toBe(0.26)
    expect(duringMargin.contributionMinor.value).toBe(12000)
    expect(duringMargin.contributionRate.value).toBe(0.1)
    expect(comparison.unitsChangeRate.value).toBe(2)
    expect(comparison.gmvChangeRate.value).toBe(1.4)
    expect(comparison.contributionRateChange.value).toBe(-0.16)
  })

  it('shows higher ad spend with lower CVR and ROAS', async () => {
    const { adapter } = createFixtureHarness()
    const [beforeResult, duringResult] = await Promise.all([
      adapter.queryAds(queryFor(['SKU-C'], BASELINE_WINDOW, 'trace-ads-before')),
      adapter.queryAds(queryFor(['SKU-C'], CURRENT_WINDOW, 'trace-ads-during')),
    ])
    const before = calculateAdMetrics(beforeResult.data, beforeResult.evidence)
    const during = calculateAdMetrics(duringResult.data, duringResult.evidence)

    expect(before.spendMinor.value).toBe(20000)
    expect(before.ctr.value).toBe(0.05)
    expect(before.cvr.value).toBe(0.04)
    expect(before.cpcMinor.value).toBe(40)
    expect(before.roas.value).toBe(5)
    expect(during.spendMinor.value).toBe(50000)
    expect(during.ctr.value).toBe(0.05)
    expect(during.cvr.value).toBe(0.016)
    expect(during.cpcMinor.value).toBe(50)
    expect(during.roas.value).toBe(1.6)
  })

  it('returns null rather than Infinity for zero denominators', async () => {
    const { adapter } = createFixtureHarness()
    const empty = await adapter.queryAds(queryFor(['SKU-Z']))
    const metrics = calculateAdMetrics(empty.data, empty.evidence)
    expect(metrics.ctr.value).toBeNull()
    expect(metrics.cvr.value).toBeNull()
    expect(metrics.cpcMinor.value).toBeNull()
    expect(metrics.roas.value).toBeNull()
  })

  it('deduplicates identical records and rejects conflicting duplicates', async () => {
    const { adapter } = createFixtureHarness()
    const result = await adapter.querySales(queryFor(['SKU-A']))
    const record = result.data.find(row => row.lineId === 'A-3')!
    const exactDuplicate = calculateSalesMetrics([record, structuredClone(record)], CURRENT_WINDOW, result.evidence)
    expect(exactDuplicate.gmvMinor.value).toBe(60000)

    const conflict: SalesRecord = { ...record, paidAmountMinor: record.paidAmountMinor + 1 }
    expect(() => calculateSalesMetrics([record, conflict], CURRENT_WINDOW, result.evidence)).toThrow(
      'Conflicting duplicate record',
    )
  })

  it('rejects cross-currency aggregation', async () => {
    const { adapter } = createFixtureHarness()
    const result = await adapter.queryAds(queryFor(['SKU-C']))
    const usd: AdRecord = { ...result.data[0]!, recordId: 'AD-USD', currency: 'USD' }
    expect(() => calculateAdMetrics([...result.data, usd], result.evidence)).toThrow(
      'Cannot aggregate multiple currencies',
    )
  })

  it('rejects margin calculation when a product cost rule is missing', async () => {
    const { adapter } = createFixtureHarness()
    const result = await adapter.querySales(queryFor(['SKU-B']))
    expect(() => calculateMarginMetrics(result.data, [], CURRENT_WINDOW, result.evidence)).toThrow(
      'Missing product cost rule',
    )
  })
})
