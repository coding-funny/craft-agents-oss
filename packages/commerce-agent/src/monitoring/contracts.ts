import { z } from 'zod'

export const MonitorRuleConfigSchema = z.object({
  ruleVersion: z.string().min(1),
  cooldownMs: z.number().int().positive(),
  maxNewCasesPerScan: z.number().int().positive().max(1_000),
  ads: z.object({ minimumSpendMinor: z.number().int().nonnegative(), minimumClicks: z.number().int().positive(), cvrDropRatio: z.number().min(0).max(1) }).strict(),
  inventory: z.object({ minimumBaselineSales: z.number().int().positive(), salesDropRatio: z.number().min(0).max(1), lowStockUnits: z.number().int().nonnegative() }).strict(),
}).strict()

const MetricsSchema = z.object({
  salesUnits: z.number().int().nonnegative(), stockUnits: z.number().int().nonnegative(),
  adSpendMinor: z.number().int().nonnegative(), adClicks: z.number().int().nonnegative(),
  adConversions: z.number().int().nonnegative(), adRevenueMinor: z.number().int().nonnegative(),
}).strict()

export const MonitorEntitySchema = z.object({
  entityType: z.enum(['SKU', 'CAMPAIGN']), entityId: z.string().min(1),
  baseline: MetricsSchema, current: MetricsSchema,
  completeFields: z.array(z.string().min(1)), promotionActive: z.boolean(), holidayHint: z.boolean(),
}).strict()

export const MonitorScanSchema = z.object({
  tenantId: z.string().min(1), shopId: z.string().min(1), snapshotId: z.string().min(1),
  window: z.object({ start: z.string().datetime({ offset: true }), end: z.string().datetime({ offset: true }) }).strict(),
  entities: z.array(MonitorEntitySchema).max(10_000),
}).strict().superRefine((scan, context) => {
  if (Date.parse(scan.window.start) >= Date.parse(scan.window.end)) context.addIssue({ code: 'custom', path: ['window'], message: 'monitor window must be positive' })
})

export type MonitorRuleConfig = z.infer<typeof MonitorRuleConfigSchema>
export type MonitorScan = z.infer<typeof MonitorScanSchema>
export type Detection = {
  anomalyType: 'ADS_EFFICIENCY' | 'SALES_INVENTORY' | 'DATA_INCOMPLETE'
  entityType: 'SKU' | 'CAMPAIGN'; entityId: string; severity: 'LOW' | 'MEDIUM' | 'HIGH'
  reason: string; metrics: Record<string, number | boolean | string>
}
