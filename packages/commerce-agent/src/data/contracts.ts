import { z } from 'zod'
import {
  AdRecordSchema,
  CurrencySchema,
  IanaTimeZoneSchema,
  IdentifierSchema,
  InventorySnapshotSchema,
  IsoDateTimeSchema,
  ProductRecordSchema,
  PromotionRecordSchema,
  SalesRecordSchema,
} from '../domain/contracts.ts'

export const DataKindSchema = z.enum(['sales', 'inventory', 'promotions', 'products', 'ads'])
export type DataKind = z.infer<typeof DataKindSchema>

export const DATA_KINDS = DataKindSchema.options

export const SourceTypeSchema = z.enum(['AUTHORIZED_EXPORT', 'SYNTHETIC_FIXTURE', 'HTTP_TEST_SOURCE'])
export type SourceType = z.infer<typeof SourceTypeSchema>

export const ImportFileSchema = z.object({
  kind: DataKindSchema,
  path: z.string().min(1).max(512),
  format: z.enum(['json', 'jsonl', 'csv']),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  schemaVersion: z.literal(1),
}).strict()

export const ImportManifestSchema = z.object({
  schemaVersion: z.literal(1),
  source: z.object({
    sourceType: SourceTypeSchema,
    sourceId: IdentifierSchema,
    owner: z.string().min(1).max(256),
    authorizationRef: z.string().min(1).max(512).optional(),
    exportedAt: IsoDateTimeSchema,
  }).strict(),
  scope: z.object({
    tenantId: IdentifierSchema,
    shopId: IdentifierSchema,
    currency: CurrencySchema,
    timezone: IanaTimeZoneSchema,
  }).strict(),
  businessWindow: z.object({
    start: IsoDateTimeSchema,
    end: IsoDateTimeSchema,
  }).strict(),
  mappingVersion: IdentifierSchema,
  metricDefinitionVersion: IdentifierSchema,
  files: z.array(ImportFileSchema).min(1).max(DATA_KINDS.length),
}).strict().superRefine((manifest, context) => {
  if (Date.parse(manifest.businessWindow.start) >= Date.parse(manifest.businessWindow.end)) {
    context.addIssue({ code: 'custom', path: ['businessWindow', 'end'], message: 'start must be before end' })
  }
  if (manifest.source.sourceType === 'AUTHORIZED_EXPORT' && !manifest.source.authorizationRef) {
    context.addIssue({
      code: 'custom',
      path: ['source', 'authorizationRef'],
      message: 'AUTHORIZED_EXPORT requires authorizationRef',
    })
  }
  if (manifest.source.sourceType === 'SYNTHETIC_FIXTURE' && manifest.source.authorizationRef) {
    context.addIssue({
      code: 'custom',
      path: ['source', 'authorizationRef'],
      message: 'SYNTHETIC_FIXTURE must not claim an authorizationRef',
    })
  }
  const kinds = manifest.files.map(file => file.kind)
  if (new Set(kinds).size !== kinds.length) {
    context.addIssue({ code: 'custom', path: ['files'], message: 'each data kind may appear only once' })
  }
})

export type ImportManifest = z.infer<typeof ImportManifestSchema>

export const ImportStatusSchema = z.enum([
  'PENDING',
  'VALIDATING',
  'APPLIED',
  'PARTIAL',
  'REJECTED',
  'ROLLED_BACK',
])
export type ImportStatus = z.infer<typeof ImportStatusSchema>

export const CompletenessValueSchema = z.enum(['complete', 'missing', 'partial'])
export type CompletenessValue = z.infer<typeof CompletenessValueSchema>

export const DataCompletenessSchema = z.object({
  sales: CompletenessValueSchema,
  inventory: CompletenessValueSchema,
  promotions: CompletenessValueSchema,
  products: CompletenessValueSchema,
  ads: CompletenessValueSchema,
}).strict()
export type DataCompleteness = z.infer<typeof DataCompletenessSchema>

export const ImportIssueSchema = z.object({
  kind: DataKindSchema,
  row: z.number().int().positive(),
  code: IdentifierSchema,
  message: z.string().min(1),
}).strict()
export type ImportIssue = z.infer<typeof ImportIssueSchema>

export const ImportBatchResultSchema = z.object({
  importId: z.string().regex(/^import_[a-f0-9]{24}$/),
  status: ImportStatusSchema,
  snapshotId: z.string().regex(/^snapshot_[a-f0-9]{24}$/).optional(),
  accepted: z.number().int().nonnegative(),
  revised: z.number().int().nonnegative(),
  duplicates: z.number().int().nonnegative(),
  quarantined: z.number().int().nonnegative(),
  completeness: DataCompletenessSchema,
  issues: z.array(ImportIssueSchema),
}).strict()
export type ImportBatchResult = z.infer<typeof ImportBatchResultSchema>

export const DataRecordVersionSchema = z.object({
  recordVersionId: z.string().regex(/^record_[a-f0-9]{24}$/),
  tenantId: IdentifierSchema,
  shopId: IdentifierSchema,
  kind: DataKindSchema,
  sourceRecordId: IdentifierSchema,
  sourceType: SourceTypeSchema,
  sourceId: IdentifierSchema,
  version: z.number().int().positive(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  payload: z.unknown(),
  businessTime: IsoDateTimeSchema,
  ingestedAt: IsoDateTimeSchema,
  importId: z.string().regex(/^import_[a-f0-9]{24}$/),
}).strict()
export type DataRecordVersion = z.infer<typeof DataRecordVersionSchema>

export const DataSnapshotSchema = z.object({
  snapshotId: z.string().regex(/^snapshot_[a-f0-9]{24}$/),
  tenantId: IdentifierSchema,
  shopId: IdentifierSchema,
  sourceType: SourceTypeSchema,
  sourceId: IdentifierSchema,
  currency: CurrencySchema,
  timezone: IanaTimeZoneSchema,
  asOf: IsoDateTimeSchema,
  importId: z.string().regex(/^import_[a-f0-9]{24}$/),
  recordVersionIds: z.array(z.string().regex(/^record_[a-f0-9]{24}$/)),
  completeness: DataCompletenessSchema,
  metricDefinitionVersion: IdentifierSchema,
  createdAt: IsoDateTimeSchema,
}).strict()
export type DataSnapshot = z.infer<typeof DataSnapshotSchema>

export const CanonicalRecordSchemas = {
  sales: SalesRecordSchema,
  inventory: InventorySnapshotSchema,
  promotions: PromotionRecordSchema,
  products: ProductRecordSchema,
  ads: AdRecordSchema,
} as const

export type CanonicalRecord = z.infer<(typeof CanonicalRecordSchemas)[DataKind]>

export function sourceRecordId(kind: DataKind, record: Record<string, unknown>): string {
  if (kind === 'sales') return String(record.lineId)
  if (kind === 'inventory') return String(record.snapshotId)
  if (kind === 'promotions') return String(record.promotionId)
  if (kind === 'products') return `${String(record.productId)}:${String(record.skuId)}`
  return String(record.recordId)
}

export function businessTime(kind: DataKind, record: Record<string, unknown>, exportedAt: string): string {
  if (kind === 'sales') return String(record.paidAt)
  if (kind === 'inventory' || kind === 'ads') return String(record.observedAt)
  if (kind === 'promotions') return String(record.start)
  return exportedAt
}

export function emptyCompleteness(): DataCompleteness {
  return { sales: 'missing', inventory: 'missing', promotions: 'missing', products: 'missing', ads: 'missing' }
}
