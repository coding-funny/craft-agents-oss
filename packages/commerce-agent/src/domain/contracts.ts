import { z } from 'zod'

const SafeIntegerSchema = z.number().int().refine(Number.isSafeInteger, 'must be a safe integer')
const NonNegativeSafeIntegerSchema = SafeIntegerSchema.nonnegative()

export const IsoDateTimeSchema = z.string().datetime({ offset: true })
export const CurrencySchema = z.string().regex(/^[A-Z]{3}$/)
export const IdentifierSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
export const IanaTimeZoneSchema = z.string().min(1).refine((timezone) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format()
    return true
  } catch {
    return false
  }
}, 'must be a valid IANA timezone')

export const TimeRangeSchema = z.object({
  start: IsoDateTimeSchema,
  end: IsoDateTimeSchema,
  timezone: IanaTimeZoneSchema,
}).superRefine((range, context) => {
  if (Date.parse(range.start) >= Date.parse(range.end)) {
    context.addIssue({ code: 'custom', message: 'start must be before end', path: ['end'] })
  }
})

export type TimeRange = z.infer<typeof TimeRangeSchema>

export const MoneySchema = z.object({
  amountMinor: SafeIntegerSchema,
  currency: CurrencySchema,
})

export type Money = z.infer<typeof MoneySchema>

export const ProductRefSchema = z.object({
  shopId: IdentifierSchema,
  productId: IdentifierSchema,
  skuId: IdentifierSchema,
  spec: z.string().min(1),
  currency: CurrencySchema,
})

export type ProductRef = z.infer<typeof ProductRefSchema>

export const RefundRecordSchema = z.object({
  refundId: IdentifierSchema,
  refundedAt: IsoDateTimeSchema,
  amountMinor: NonNegativeSafeIntegerSchema,
})

export type RefundRecord = z.infer<typeof RefundRecordSchema>

export const SalesRecordSchema = z.object({
  lineId: IdentifierSchema,
  orderId: IdentifierSchema,
  shopId: IdentifierSchema,
  productId: IdentifierSchema,
  skuId: IdentifierSchema,
  paidAt: IsoDateTimeSchema,
  quantity: NonNegativeSafeIntegerSchema,
  paidAmountMinor: NonNegativeSafeIntegerSchema,
  currency: CurrencySchema,
  status: z.enum(['PAID', 'CANCELLED']),
  refunds: z.array(RefundRecordSchema).default([]),
})

export type SalesRecord = z.infer<typeof SalesRecordSchema>

export const InventorySnapshotSchema = z.object({
  snapshotId: IdentifierSchema,
  shopId: IdentifierSchema,
  productId: IdentifierSchema,
  skuId: IdentifierSchema,
  observedAt: IsoDateTimeSchema,
  availableQty: NonNegativeSafeIntegerSchema,
  lockedQty: NonNegativeSafeIntegerSchema,
})

export type InventorySnapshot = z.infer<typeof InventorySnapshotSchema>

export const PromotionRecordSchema = z.object({
  promotionId: IdentifierSchema,
  shopId: IdentifierSchema,
  skuIds: z.array(IdentifierSchema).min(1),
  start: IsoDateTimeSchema,
  end: IsoDateTimeSchema,
  kind: z.enum(['PRICE_DISCOUNT', 'MERCHANT_COUPON', 'PLATFORM_SUBSIDY', 'MEMBER_PRICE']),
  sponsor: z.enum(['MERCHANT', 'PLATFORM', 'SHARED']),
  stackingRule: z.string().min(1),
}).superRefine((promotion, context) => {
  if (Date.parse(promotion.start) >= Date.parse(promotion.end)) {
    context.addIssue({ code: 'custom', message: 'promotion start must be before end', path: ['end'] })
  }
})

export type PromotionRecord = z.infer<typeof PromotionRecordSchema>

export const AdRecordSchema = z.object({
  recordId: IdentifierSchema,
  campaignId: IdentifierSchema,
  shopId: IdentifierSchema,
  productId: IdentifierSchema,
  skuId: IdentifierSchema,
  observedAt: IsoDateTimeSchema,
  impressions: NonNegativeSafeIntegerSchema,
  clicks: NonNegativeSafeIntegerSchema,
  attributedOrders: NonNegativeSafeIntegerSchema,
  spendMinor: NonNegativeSafeIntegerSchema,
  attributedRevenueMinor: NonNegativeSafeIntegerSchema,
  currency: CurrencySchema,
  attributionWindowDays: NonNegativeSafeIntegerSchema,
})

export type AdRecord = z.infer<typeof AdRecordSchema>

export const ProductRecordSchema = ProductRefSchema.extend({
  unitCostMinor: NonNegativeSafeIntegerSchema,
  fulfillmentCostMinor: NonNegativeSafeIntegerSchema,
  platformFeeRateBps: NonNegativeSafeIntegerSchema.max(10_000),
})

export type ProductRecord = z.infer<typeof ProductRecordSchema>

export const EvidenceRefSchema = z.object({
  evidenceId: z.string().regex(/^ev_[a-f0-9]{24}$/),
  source: z.string().min(1),
  locator: z.string().min(1),
  traceId: IdentifierSchema,
})

export type EvidenceRef = z.infer<typeof EvidenceRefSchema>

export const MetricValueSchema = <T extends z.ZodTypeAny>(valueSchema: T) => z.object({
  value: valueSchema,
  unit: z.string().min(1),
  evidence: z.array(EvidenceRefSchema).min(1),
})

export type MetricValue<T> = {
  value: T
  unit: string
  evidence: EvidenceRef[]
}

export const QueryContextSchema = z.object({
  runId: IdentifierSchema,
  caseId: IdentifierSchema,
  traceId: IdentifierSchema,
  shopId: IdentifierSchema,
  skuIds: z.array(IdentifierSchema).min(1),
  window: TimeRangeSchema,
  asOf: IsoDateTimeSchema,
  currency: CurrencySchema,
})

export type QueryContext = z.infer<typeof QueryContextSchema>

export type ToolStatus = 'ok' | 'missing' | 'partial' | 'conflict'

export type ToolEnvelope<T> = {
  status: ToolStatus
  data: T
  source: string
  asOf: string
  query: QueryContext
  traceId: string
  evidence: EvidenceRef[]
  warnings: string[]
  /** Physical handler attempts consumed by the server-side retry policy. */
  attempts?: number
  truncated?: boolean
  originalBytes?: number
}

export type EvidenceRecord = {
  evidenceId: string
  tool: string
  source: string
  asOf: string
  query: Record<string, unknown>
  recordRefs: string[]
  content: unknown
  summary: string
  createdAt: string
  governance?: EvidenceGovernance
}

export type EvidenceGovernance = {
  schemaVersion: 2
  tenantId: string
  shopId: string
  snapshotId: string
  sourceType: 'AUTHORIZED_EXPORT' | 'SYNTHETIC_FIXTURE' | 'HTTP_TEST_SOURCE'
  sources?: Array<{
    sourceType: 'AUTHORIZED_EXPORT' | 'SYNTHETIC_FIXTURE' | 'HTTP_TEST_SOURCE'
    sourceId: string
    importId: string
  }>
  sourceRecordIds: string[]
  metricDefinitionVersion: string
  contentHash: string
  businessTimeRange: { start: string; end: string }
  ingestedAt: string
}

export const SalesRecordArraySchema = z.array(SalesRecordSchema)
export const InventorySnapshotArraySchema = z.array(InventorySnapshotSchema)
export const PromotionRecordArraySchema = z.array(PromotionRecordSchema)
export const AdRecordArraySchema = z.array(AdRecordSchema)
export const ProductRecordArraySchema = z.array(ProductRecordSchema)
