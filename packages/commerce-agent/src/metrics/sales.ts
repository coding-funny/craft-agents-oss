import type { EvidenceRef, MetricValue, SalesRecord, TimeRange } from '../domain/contracts.ts'
import { deduplicateBy, isInRange, metric, singleCurrency, sumSafe } from './common.ts'

export type SalesMetrics = {
  currency: string | null
  gmvMinor: MetricValue<number>
  paidOrderCount: MetricValue<number>
  unitsSold: MetricValue<number>
  refundAmountMinor: MetricValue<number>
  netSalesMinor: MetricValue<number>
}

export function calculateSalesMetrics(
  input: SalesRecord[],
  window: TimeRange,
  evidence: EvidenceRef[],
): SalesMetrics {
  const records = deduplicateBy(input, row => row.lineId)
  const paidRows = records.filter(row => row.status === 'PAID' && isInRange(row.paidAt, window.start, window.end))
  const refundEvents = records.flatMap(row => row.refunds
    .filter(refund => isInRange(refund.refundedAt, window.start, window.end))
    .map(refund => ({ ...refund, currency: row.currency })))
  const currency = singleCurrency([
    ...paidRows.map(row => row.currency),
    ...refundEvents.map(refund => refund.currency),
  ])
  const gmvMinor = sumSafe(paidRows.map(row => row.paidAmountMinor), 'GMV')
  const refundAmountMinor = sumSafe(refundEvents.map(refund => refund.amountMinor), 'refund amount')
  const netSalesMinor = sumSafe([gmvMinor, -refundAmountMinor], 'net sales')
  const orderIds = new Set(paidRows.map(row => row.orderId))
  const unitsSold = sumSafe(paidRows.map(row => row.quantity), 'units sold')

  return {
    currency,
    gmvMinor: metric(gmvMinor, currency ? `${currency}_minor` : 'money_minor', evidence),
    paidOrderCount: metric(orderIds.size, 'orders', evidence),
    unitsSold: metric(unitsSold, 'units', evidence),
    refundAmountMinor: metric(refundAmountMinor, currency ? `${currency}_minor` : 'money_minor', evidence),
    netSalesMinor: metric(netSalesMinor, currency ? `${currency}_minor` : 'money_minor', evidence),
  }
}
