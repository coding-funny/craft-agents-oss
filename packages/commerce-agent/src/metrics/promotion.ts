import type { EvidenceRef, MetricValue } from '../domain/contracts.ts'
import type { MarginMetrics } from './margin.ts'
import { mergeEvidence, metric, ratio } from './common.ts'
import type { SalesMetrics } from './sales.ts'

export type PromotionComparison = {
  unitsBefore: MetricValue<number>
  unitsDuring: MetricValue<number>
  unitsChangeRate: MetricValue<number | null>
  gmvBeforeMinor: MetricValue<number>
  gmvDuringMinor: MetricValue<number>
  gmvChangeRate: MetricValue<number | null>
  contributionRateBefore: MetricValue<number | null>
  contributionRateDuring: MetricValue<number | null>
  contributionRateChange: MetricValue<number | null>
}

export function comparePromotionPerformance(
  beforeSales: SalesMetrics,
  duringSales: SalesMetrics,
  beforeMargin: MarginMetrics,
  duringMargin: MarginMetrics,
  promotionEvidence: EvidenceRef[],
): PromotionComparison {
  const evidence = mergeEvidence(
    promotionEvidence,
    beforeSales.unitsSold.evidence,
    duringSales.unitsSold.evidence,
    beforeMargin.contributionRate.evidence,
    duringMargin.contributionRate.evidence,
  )
  const beforeRate = beforeMargin.contributionRate.value
  const duringRate = duringMargin.contributionRate.value
  const rateChange = beforeRate === null || duringRate === null
    ? null
    : Math.round((duringRate - beforeRate) * 10_000) / 10_000

  return {
    unitsBefore: metric(beforeSales.unitsSold.value, 'units', evidence),
    unitsDuring: metric(duringSales.unitsSold.value, 'units', evidence),
    unitsChangeRate: metric(
      ratio(duringSales.unitsSold.value - beforeSales.unitsSold.value, beforeSales.unitsSold.value),
      'ratio',
      evidence,
    ),
    gmvBeforeMinor: metric(beforeSales.gmvMinor.value, beforeSales.gmvMinor.unit, evidence),
    gmvDuringMinor: metric(duringSales.gmvMinor.value, duringSales.gmvMinor.unit, evidence),
    gmvChangeRate: metric(
      ratio(duringSales.gmvMinor.value - beforeSales.gmvMinor.value, beforeSales.gmvMinor.value),
      'ratio',
      evidence,
    ),
    contributionRateBefore: metric(beforeRate, 'ratio', evidence),
    contributionRateDuring: metric(duringRate, 'ratio', evidence),
    contributionRateChange: metric(rateChange, 'ratio_points', evidence),
  }
}
