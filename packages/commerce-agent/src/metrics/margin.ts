import type { EvidenceRef, MetricValue, ProductRecord, SalesRecord, TimeRange } from '../domain/contracts.ts'
import { invalidArgument } from '../domain/errors.ts'
import {
  assertSafeInteger,
  deduplicateBy,
  isInRange,
  metric,
  ratio,
  singleCurrency,
  sumSafe,
} from './common.ts'
import { calculateSalesMetrics } from './sales.ts'

export type MarginMetrics = {
  currency: string | null
  netSalesMinor: MetricValue<number>
  productCostMinor: MetricValue<number>
  platformFeeMinor: MetricValue<number>
  fulfillmentCostMinor: MetricValue<number>
  contributionMinor: MetricValue<number>
  contributionRate: MetricValue<number | null>
}

export function calculateMarginMetrics(
  salesInput: SalesRecord[],
  productsInput: ProductRecord[],
  window: TimeRange,
  evidence: EvidenceRef[],
): MarginMetrics {
  const sales = deduplicateBy(salesInput, row => row.lineId)
  const products = deduplicateBy(productsInput, row => row.skuId)
  const productBySku = new Map(products.map(product => [product.skuId, product]))
  const paidRows = sales.filter(row => row.status === 'PAID' && isInRange(row.paidAt, window.start, window.end))
  const refundRows = sales.filter(row => row.refunds.some(
    refund => isInRange(refund.refundedAt, window.start, window.end),
  ))
  const salesMetrics = calculateSalesMetrics(sales, window, evidence)

  for (const row of deduplicateBy([...paidRows, ...refundRows], row => row.lineId)) {
    if (!productBySku.has(row.skuId)) throw invalidArgument(`Missing product cost rule for SKU: ${row.skuId}`)
  }

  const currency = singleCurrency([
    ...paidRows.map(row => row.currency),
    ...refundRows.map(row => row.currency),
    ...deduplicateBy([...paidRows, ...refundRows], row => row.lineId)
      .map(row => productBySku.get(row.skuId)!.currency),
  ]) ?? salesMetrics.currency
  const productCostMinor = sumSafe(paidRows.map(row => {
    const product = productBySku.get(row.skuId)!
    return assertSafeInteger(row.quantity * product.unitCostMinor, 'product cost')
  }), 'product cost')
  const fulfillmentCostMinor = sumSafe(paidRows.map(row => {
    const product = productBySku.get(row.skuId)!
    return assertSafeInteger(row.quantity * product.fulfillmentCostMinor, 'fulfillment cost')
  }), 'fulfillment cost')
  const paidFees = paidRows.map(row => Math.round(
    (row.paidAmountMinor * productBySku.get(row.skuId)!.platformFeeRateBps) / 10_000,
  ))
  const refundedFees = refundRows.flatMap(row => row.refunds
    .filter(refund => isInRange(refund.refundedAt, window.start, window.end))
    .map(refund => Math.round(
      (refund.amountMinor * productBySku.get(row.skuId)!.platformFeeRateBps) / 10_000,
    )))
  const platformFeeMinor = sumSafe([...paidFees, ...refundedFees.map(fee => -fee)], 'platform fee')
  const contributionMinor = sumSafe([
    salesMetrics.netSalesMinor.value,
    -productCostMinor,
    -platformFeeMinor,
    -fulfillmentCostMinor,
  ], 'contribution')

  return {
    currency,
    netSalesMinor: metric(
      salesMetrics.netSalesMinor.value,
      currency ? `${currency}_minor` : 'money_minor',
      evidence,
    ),
    productCostMinor: metric(productCostMinor, currency ? `${currency}_minor` : 'money_minor', evidence),
    platformFeeMinor: metric(platformFeeMinor, currency ? `${currency}_minor` : 'money_minor', evidence),
    fulfillmentCostMinor: metric(
      fulfillmentCostMinor,
      currency ? `${currency}_minor` : 'money_minor',
      evidence,
    ),
    contributionMinor: metric(contributionMinor, currency ? `${currency}_minor` : 'money_minor', evidence),
    contributionRate: metric(ratio(contributionMinor, salesMetrics.netSalesMinor.value), 'ratio', evidence),
  }
}
