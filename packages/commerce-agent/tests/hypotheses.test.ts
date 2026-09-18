import { describe, expect, it } from 'bun:test'
import { diagnoseAdvertising, selectDiagnosisRoute } from '../src/diagnosis/hypotheses.ts'

const BASE = {
  attributionAvailable: true,
  attributionAligned: true,
  baselineSpend: 100,
  currentSpend: 100,
  baselineClicks: 100,
  currentClicks: 100,
  baselineCvr: 0.1,
  currentCvr: 0.1,
  baselineSales: 1000,
  currentSales: 1000,
  inventoryConstrained: false,
}

describe('advertising diagnosis branches', () => {
  it('detects spend growth with conversion decline', () => {
    expect(diagnoseAdvertising({ ...BASE, currentSpend: 150, currentCvr: 0.05 }).code)
      .toBe('SPEND_UP_CONVERSION_DOWN')
  })

  it('prioritizes inventory constraint when clicks grow', () => {
    expect(diagnoseAdvertising({ ...BASE, currentClicks: 150, inventoryConstrained: true }).code)
      .toBe('CLICK_GROWTH_INVENTORY_CONSTRAINT')
  })

  it('requests organic-traffic evidence when ads are stable but sales fall', () => {
    const result = diagnoseAdvertising({ ...BASE, currentSales: 700 })
    expect(result.code).toBe('ADS_STABLE_SALES_DOWN')
    expect(result.missingCriticalData).toBe(true)
  })

  it('treats missing attribution as evidence-insufficient', () => {
    const result = diagnoseAdvertising({ ...BASE, attributionAvailable: false })
    expect(result.code).toBe('MISSING_ATTRIBUTION')
    expect(result.missingCriticalData).toBe(true)
  })
})

describe('data-driven diagnosis route', () => {
  it('selects routes from observed metrics rather than case names', () => {
    expect(selectDiagnosisRoute({
      baselineNetSales: 100, currentNetSales: 70, currentStockoutSkuCount: 1,
      promotionCount: 1, baselineContributionRate: 0.3, currentContributionRate: 0.1,
      advertisingAvailable: true,
    })).toBe('INVENTORY_CONSTRAINT')
    expect(selectDiagnosisRoute({
      baselineNetSales: 100, currentNetSales: 140, currentStockoutSkuCount: 0,
      promotionCount: 1, baselineContributionRate: 0.3, currentContributionRate: 0.1,
      advertisingAvailable: true,
    })).toBe('PROMOTION_MARGIN')
    expect(selectDiagnosisRoute({
      baselineNetSales: 100, currentNetSales: 80, currentStockoutSkuCount: 0,
      promotionCount: 0, baselineContributionRate: 0.3, currentContributionRate: 0.3,
      advertisingAvailable: true,
    })).toBe('AD_EFFICIENCY')
  })
})
