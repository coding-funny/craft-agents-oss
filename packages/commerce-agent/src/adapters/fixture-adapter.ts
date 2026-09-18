import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { ZodType } from 'zod'
import {
  AdRecordArraySchema,
  InventorySnapshotArraySchema,
  ProductRecordArraySchema,
  PromotionRecordArraySchema,
  QueryContextSchema,
  SalesRecordArraySchema,
  type AdRecord,
  type InventorySnapshot,
  type ProductRecord,
  type PromotionRecord,
  type QueryContext,
  type SalesRecord,
  type ToolEnvelope,
} from '../domain/contracts.ts'
import { CommerceError } from '../domain/errors.ts'
import { EvidenceRepository } from '../evidence/evidence-repository.ts'
import type { CommerceAdapter } from './commerce-adapter.ts'

type FixtureName = 'sales' | 'inventory' | 'promotions' | 'ads' | 'products'

const FILE_NAMES: Record<FixtureName, string> = {
  sales: 'sales.json',
  inventory: 'inventory.json',
  promotions: 'promotions.json',
  ads: 'ads.json',
  products: 'products.json',
}

function inWindow(instant: string, query: QueryContext): boolean {
  const timestamp = Date.parse(instant)
  return timestamp >= Date.parse(query.window.start) && timestamp < Date.parse(query.window.end)
}

function matchesScope(record: { shopId: string; skuId: string }, query: QueryContext): boolean {
  return record.shopId === query.shopId && query.skuIds.includes(record.skuId)
}

function promotionMatches(record: PromotionRecord, query: QueryContext): boolean {
  return record.shopId === query.shopId
    && record.skuIds.some(skuId => query.skuIds.includes(skuId))
    && Date.parse(record.start) < Date.parse(query.window.end)
    && Date.parse(record.end) > Date.parse(query.window.start)
}

function toQueryRecord(query: QueryContext): Record<string, unknown> {
  return { ...query, window: { ...query.window }, skuIds: [...query.skuIds] }
}

export class FixtureAdapter implements CommerceAdapter {
  readonly #fixtureDir: string
  readonly #allowedShopId: string
  readonly #evidence: EvidenceRepository
  readonly #cache = new Map<FixtureName, unknown>()

  constructor(options: { fixtureDir: string; allowedShopId: string; evidence: EvidenceRepository }) {
    this.#fixtureDir = options.fixtureDir
    this.#allowedShopId = options.allowedShopId
    this.#evidence = options.evidence
  }

  async querySales(input: QueryContext, signal?: AbortSignal): Promise<ToolEnvelope<SalesRecord[]>> {
    signal?.throwIfAborted()
    const query = this.#parseQuery(input)
    const all = await this.#load('sales', SalesRecordArraySchema)
    const records = all.filter(record => matchesScope(record, query) && (
      inWindow(record.paidAt, query) || record.refunds.some(refund => inWindow(refund.refundedAt, query))
    ))
    return this.#envelope('query_sales', 'fixture-v1/sales.json', query, records, records.map(row => row.lineId))
  }

  async queryInventory(input: QueryContext, signal?: AbortSignal): Promise<ToolEnvelope<InventorySnapshot[]>> {
    signal?.throwIfAborted()
    const query = this.#parseQuery(input)
    const all = await this.#load('inventory', InventorySnapshotArraySchema)
    const records = all.filter(record => matchesScope(record, query) && inWindow(record.observedAt, query))
    return this.#envelope(
      'query_inventory',
      'fixture-v1/inventory.json',
      query,
      records,
      records.map(row => row.snapshotId),
    )
  }

  async queryPromotions(input: QueryContext, signal?: AbortSignal): Promise<ToolEnvelope<PromotionRecord[]>> {
    signal?.throwIfAborted()
    const query = this.#parseQuery(input)
    const all = await this.#load('promotions', PromotionRecordArraySchema)
    const records = all.filter(record => promotionMatches(record, query))
    return this.#envelope(
      'query_promotions',
      'fixture-v1/promotions.json',
      query,
      records,
      records.map(row => row.promotionId),
    )
  }

  async queryAds(input: QueryContext, signal?: AbortSignal): Promise<ToolEnvelope<AdRecord[]>> {
    signal?.throwIfAborted()
    const query = this.#parseQuery(input)
    const all = await this.#load('ads', AdRecordArraySchema)
    const records = all.filter(record => matchesScope(record, query) && inWindow(record.observedAt, query))
    return this.#envelope('query_ads', 'fixture-v1/ads.json', query, records, records.map(row => row.recordId))
  }

  async queryProducts(input: QueryContext, signal?: AbortSignal): Promise<ToolEnvelope<ProductRecord[]>> {
    signal?.throwIfAborted()
    const query = this.#parseQuery(input)
    const all = await this.#load('products', ProductRecordArraySchema)
    const records = all.filter(record => matchesScope(record, query))
    return this.#envelope(
      'query_products',
      'fixture-v1/products.json',
      query,
      records,
      records.map(row => `${row.productId}:${row.skuId}`),
    )
  }

  #parseQuery(input: QueryContext): QueryContext {
    const query = QueryContextSchema.parse(input)
    if (query.shopId !== this.#allowedShopId) {
      throw new CommerceError('INVALID_ARGUMENT', `Shop is outside the configured fixture scope: ${query.shopId}`)
    }
    if (query.currency !== 'CNY') {
      throw new CommerceError('INVALID_ARGUMENT', `Fixture v1 only supports CNY, received ${query.currency}`)
    }
    return query
  }

  async #load<T>(name: FixtureName, schema: ZodType<T>): Promise<T> {
    const cached = this.#cache.get(name)
    if (cached !== undefined) return cached as T

    const path = resolve(this.#fixtureDir, FILE_NAMES[name])
    try {
      const parsedJson: unknown = JSON.parse(await readFile(path, 'utf8'))
      const parsed = schema.parse(parsedJson)
      this.#cache.set(name, parsed)
      return parsed
    } catch (error) {
      if (error instanceof CommerceError) throw error
      throw new CommerceError('INVALID_ARGUMENT', `Invalid ${name} fixture`, {
        path,
        cause: error instanceof Error ? error.message : String(error),
      })
    }
  }

  #envelope<T>(
    tool: string,
    source: string,
    query: QueryContext,
    data: T,
    recordRefs: string[],
  ): ToolEnvelope<T> {
    const evidence = this.#evidence.capture({
      tool,
      source,
      asOf: query.asOf,
      traceId: query.traceId,
      query: toQueryRecord(query),
      recordRefs,
      content: data,
      summary: `${tool} returned ${recordRefs.length} fixture record(s)`,
    })

    return {
      status: recordRefs.length === 0 ? 'missing' : 'ok',
      data,
      source,
      asOf: query.asOf,
      query,
      traceId: query.traceId,
      evidence: [evidence],
      warnings: recordRefs.length === 0 ? ['No records matched the requested scope and time range.'] : [],
    }
  }
}
