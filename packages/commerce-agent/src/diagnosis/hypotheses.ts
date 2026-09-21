import { assessConfidence } from './confidence.ts'
import type { ReportHypothesis } from '../reports/schema.ts'

export type HypothesisInput = {
  statement: string
  supportingEvidenceIds: string[]
  counterEvidenceIds?: string[]
  limitations?: string[]
  hasConflict?: boolean
  missingCriticalData?: boolean
}

export function buildHypothesis(input: HypothesisInput): ReportHypothesis {
  const counterEvidenceIds = input.counterEvidenceIds ?? []
  const confidence = assessConfidence({
    supportingEvidenceCount: input.supportingEvidenceIds.length,
    counterEvidenceCount: counterEvidenceIds.length,
    hasConflict: input.hasConflict,
    missingCriticalData: input.missingCriticalData,
  })
  return {
    kind: 'HYPOTHESIS',
    statement: input.statement,
    confidence: confidence.level,
    confidenceScore: confidence.score,
    supportingEvidenceIds: input.supportingEvidenceIds,
    counterEvidenceIds,
    limitations: input.limitations ?? [],
  }
}

export function changeRate(before: number | null, current: number | null): number | null {
  if (before === null || current === null || before === 0) return null
  return Math.round(((current - before) / before) * 10_000) / 10_000
}

export type AdvertisingSignal = {
  code: 'MISSING_ATTRIBUTION' | 'CLICK_GROWTH_INVENTORY_CONSTRAINT' | 'SPEND_UP_CONVERSION_DOWN' | 'ADS_STABLE_SALES_DOWN' | 'NO_PRIMARY_SIGNAL'
  statement: string
  missingCriticalData: boolean
}

export type AdvertisingSignalInput = {
  attributionAvailable: boolean
  attributionAligned: boolean
  baselineSpend: number
  currentSpend: number
  baselineClicks: number
  currentClicks: number
  baselineCvr: number | null
  currentCvr: number | null
  baselineSales: number
  currentSales: number
  inventoryConstrained: boolean
}

export function diagnoseAdvertising(input: AdvertisingSignalInput): AdvertisingSignal {
  if (!input.attributionAvailable) {
    return {
      code: 'MISSING_ATTRIBUTION',
      statement: 'Advertising attribution is unavailable, so paid-traffic contribution is evidence-insufficient.',
      missingCriticalData: true,
    }
  }
  if (input.currentClicks > input.baselineClicks && input.inventoryConstrained) {
    return {
      code: 'CLICK_GROWTH_INVENTORY_CONSTRAINT',
      statement: 'Clicks increased while inventory was constrained; availability may limit conversion.',
      missingCriticalData: !input.attributionAligned,
    }
  }
  if (input.currentSpend > input.baselineSpend
    && input.baselineCvr !== null
    && input.currentCvr !== null
    && input.currentCvr < input.baselineCvr) {
    return {
      code: 'SPEND_UP_CONVERSION_DOWN',
      statement: 'Advertising spend increased while attributed conversion rate decreased.',
      missingCriticalData: !input.attributionAligned,
    }
  }
  const spendChange = changeRate(input.baselineSpend, input.currentSpend)
  if (spendChange !== null && Math.abs(spendChange) <= 0.05 && input.currentSales < input.baselineSales) {
    return {
      code: 'ADS_STABLE_SALES_DOWN',
      statement: 'Advertising spend is stable while total sales decreased; organic-traffic evidence is required.',
      missingCriticalData: true,
    }
  }
  return {
    code: 'NO_PRIMARY_SIGNAL',
    statement: 'No primary advertising anomaly rule matched the aligned comparison.',
    missingCriticalData: !input.attributionAligned,
  }
}

export type DiagnosisRoute = 'INVENTORY_CONSTRAINT' | 'PROMOTION_MARGIN' | 'AD_EFFICIENCY' | 'INSUFFICIENT_DATA'

export function selectDiagnosisRoute(input: {
  baselineNetSales: number
  currentNetSales: number
  currentStockoutSkuCount: number
  promotionCount: number
  baselineContributionRate: number | null
  currentContributionRate: number | null
  advertisingAvailable: boolean
}): DiagnosisRoute {
  if (input.currentNetSales < input.baselineNetSales && input.currentStockoutSkuCount > 0) {
    return 'INVENTORY_CONSTRAINT'
  }
  if (input.promotionCount > 0
    && input.baselineContributionRate !== null
    && input.currentContributionRate !== null
    && input.currentContributionRate < input.baselineContributionRate) {
    return 'PROMOTION_MARGIN'
  }
  if (input.advertisingAvailable) return 'AD_EFFICIENCY'
  return 'INSUFFICIENT_DATA'
}
