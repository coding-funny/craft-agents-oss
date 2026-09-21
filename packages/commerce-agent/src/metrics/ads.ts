import type { AdRecord, EvidenceRef, MetricValue } from '../domain/contracts.ts'
import { deduplicateBy, metric, ratio, singleCurrency, sumSafe } from './common.ts'

export type AdMetrics = {
  currency: string | null
  impressions: MetricValue<number>
  clicks: MetricValue<number>
  attributedOrders: MetricValue<number>
  spendMinor: MetricValue<number>
  attributedRevenueMinor: MetricValue<number>
  ctr: MetricValue<number | null>
  cvr: MetricValue<number | null>
  cpcMinor: MetricValue<number | null>
  roas: MetricValue<number | null>
  attributionWindowDays: MetricValue<number | null>
}

export function calculateAdMetrics(input: AdRecord[], evidence: EvidenceRef[]): AdMetrics {
  const records = deduplicateBy(input, row => row.recordId)
  const currency = singleCurrency(records.map(row => row.currency))
  const impressions = sumSafe(records.map(row => row.impressions), 'ad impressions')
  const clicks = sumSafe(records.map(row => row.clicks), 'ad clicks')
  const attributedOrders = sumSafe(records.map(row => row.attributedOrders), 'attributed orders')
  const spendMinor = sumSafe(records.map(row => row.spendMinor), 'ad spend')
  const attributedRevenueMinor = sumSafe(records.map(row => row.attributedRevenueMinor), 'attributed revenue')
  const attributionWindows = [...new Set(records.map(row => row.attributionWindowDays))]

  return {
    currency,
    impressions: metric(impressions, 'impressions', evidence),
    clicks: metric(clicks, 'clicks', evidence),
    attributedOrders: metric(attributedOrders, 'orders', evidence),
    spendMinor: metric(spendMinor, currency ? `${currency}_minor` : 'money_minor', evidence),
    attributedRevenueMinor: metric(
      attributedRevenueMinor,
      currency ? `${currency}_minor` : 'money_minor',
      evidence,
    ),
    ctr: metric(ratio(clicks, impressions), 'ratio', evidence),
    cvr: metric(ratio(attributedOrders, clicks), 'ratio', evidence),
    cpcMinor: metric(ratio(spendMinor, clicks), currency ? `${currency}_minor_per_click` : 'money_minor_per_click', evidence),
    roas: metric(ratio(attributedRevenueMinor, spendMinor), 'ratio', evidence),
    attributionWindowDays: metric(attributionWindows.length === 1 ? attributionWindows[0]! : null, 'days', evidence),
  }
}
