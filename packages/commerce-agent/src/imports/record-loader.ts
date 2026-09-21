import { z } from 'zod'
import {
  CanonicalRecordSchemas,
  type CanonicalRecord,
  type DataKind,
  type ImportManifest,
} from '../data/contracts.ts'
import type { LoadedImportFile } from './manifest-loader.ts'

export type RawImportRow = { rowNumber: number; value: unknown }
export type ParsedImportRow = RawImportRow & { record?: CanonicalRecord; error?: { code: string; message: string } }

const KNOWN_FIELDS: Record<DataKind, ReadonlySet<string>> = {
  sales: new Set([
    'lineId', 'orderId', 'shopId', 'productId', 'skuId', 'paidAt', 'quantity', 'paidAmountMinor',
    'currency', 'status', 'refunds',
  ]),
  inventory: new Set([
    'snapshotId', 'shopId', 'productId', 'skuId', 'observedAt', 'availableQty', 'lockedQty',
  ]),
  promotions: new Set([
    'promotionId', 'shopId', 'skuIds', 'start', 'end', 'kind', 'sponsor', 'stackingRule',
  ]),
  products: new Set([
    'shopId', 'productId', 'skuId', 'spec', 'currency', 'unitCostMinor', 'fulfillmentCostMinor',
    'platformFeeRateBps',
  ]),
  ads: new Set([
    'recordId', 'campaignId', 'shopId', 'productId', 'skuId', 'observedAt', 'impressions', 'clicks',
    'attributedOrders', 'spendMinor', 'attributedRevenueMinor', 'currency', 'attributionWindowDays',
  ]),
}

const INTEGER_FIELDS = new Set([
  'quantity', 'paidAmountMinor', 'availableQty', 'lockedQty', 'unitCostMinor', 'fulfillmentCostMinor',
  'platformFeeRateBps', 'impressions', 'clicks', 'attributedOrders', 'spendMinor',
  'attributedRevenueMinor', 'attributionWindowDays',
])

function parseCsv(content: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index]!
    if (quoted) {
      if (character === '"' && content[index + 1] === '"') {
        field += '"'
        index += 1
      } else if (character === '"') quoted = false
      else field += character
      continue
    }
    if (character === '"') quoted = true
    else if (character === ',') {
      row.push(field)
      field = ''
    } else if (character === '\n') {
      row.push(field.replace(/\r$/, ''))
      if (row.some(value => value.length > 0)) rows.push(row)
      row = []
      field = ''
    } else field += character
  }
  if (quoted) throw new Error('unterminated quoted CSV field')
  row.push(field.replace(/\r$/, ''))
  if (row.some(value => value.length > 0)) rows.push(row)
  return rows
}

function csvRows(content: string): RawImportRow[] {
  const rows = parseCsv(content)
  const header = rows.shift()
  if (!header || header.some(name => name.length === 0)) throw new Error('CSV requires a non-empty header')
  if (new Set(header).size !== header.length) throw new Error('CSV header contains duplicate columns')
  return rows.map((values, index) => {
    if (values.length !== header.length) {
      return { rowNumber: index + 2, value: { __csvError: `expected ${header.length} columns, received ${values.length}` } }
    }
    const value: Record<string, unknown> = {}
    for (let column = 0; column < header.length; column += 1) {
      const key = header[column]!
      const raw = values[column]!
      if (INTEGER_FIELDS.has(key)) value[key] = Number(raw)
      else if (key === 'refunds' || key === 'skuIds') {
        try {
          value[key] = JSON.parse(raw)
        } catch {
          value[key] = raw
        }
      } else value[key] = raw
    }
    return { rowNumber: index + 2, value }
  })
}

export function loadRawRows(file: LoadedImportFile): RawImportRow[] {
  const content = new TextDecoder().decode(file.bytes)
  if (file.format === 'json') {
    const parsed: unknown = JSON.parse(content)
    if (!Array.isArray(parsed)) throw new Error('JSON import files must contain an array')
    return parsed.map((value, index) => ({ rowNumber: index + 1, value }))
  }
  if (file.format === 'jsonl') {
    return content.split(/\r?\n/).flatMap((line, index) => {
      if (!line.trim()) return []
      try {
        return [{ rowNumber: index + 1, value: JSON.parse(line) }]
      } catch {
        return [{ rowNumber: index + 1, value: { __jsonlError: 'invalid JSON' } }]
      }
    })
  }
  return csvRows(content)
}

function scopeError(kind: DataKind, value: Record<string, unknown>, manifest: ImportManifest): string | undefined {
  if (value.shopId !== manifest.scope.shopId) return 'record shopId conflicts with manifest scope'
  if ((kind === 'sales' || kind === 'products' || kind === 'ads') && value.currency !== manifest.scope.currency) {
    return 'record currency conflicts with manifest scope'
  }
  return undefined
}

function zodMessage(error: z.ZodError): string {
  return error.issues.map(issue => `${issue.path.join('.') || 'row'}: ${issue.message}`).join('; ')
}

export function parseImportRows(
  kind: DataKind,
  rows: RawImportRow[],
  manifest: ImportManifest,
): ParsedImportRow[] {
  return rows.map(row => {
    if (!row.value || typeof row.value !== 'object' || Array.isArray(row.value)) {
      return { ...row, error: { code: 'INVALID_ROW', message: 'row must be an object' } }
    }
    const value = row.value as Record<string, unknown>
    if ('__csvError' in value || '__jsonlError' in value) {
      return { ...row, error: { code: 'INVALID_SERIALIZATION', message: String(value.__csvError ?? value.__jsonlError) } }
    }
    const unknown = Object.keys(value).filter(key => !KNOWN_FIELDS[kind].has(key))
    if (unknown.length > 0) {
      return { ...row, error: { code: 'UNKNOWN_FIELDS', message: `unknown fields: ${unknown.sort().join(', ')}` } }
    }
    const parsed = CanonicalRecordSchemas[kind].safeParse(value)
    if (!parsed.success) {
      return { ...row, error: { code: 'SCHEMA_INVALID', message: zodMessage(parsed.error) } }
    }
    const scoped = scopeError(kind, parsed.data as Record<string, unknown>, manifest)
    if (scoped) return { ...row, error: { code: 'SCOPE_CONFLICT', message: scoped } }
    return { ...row, record: parsed.data as CanonicalRecord }
  })
}
