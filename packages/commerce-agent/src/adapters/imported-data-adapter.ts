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
import { contentHash } from '../data/hash.ts'
import type { DataKind, DataRecordVersion, DataSnapshot } from '../data/contracts.ts'
import { CommerceError } from '../domain/errors.ts'
import { EvidenceRepository } from '../evidence/evidence-repository.ts'
import type { DataGovernanceRepository } from '../storage/ports/data-governance-repository.ts'
import type { CommerceAdapter } from './commerce-adapter.ts'

type Binding = { tenantId: string; shopId: string; snapshotId: string }

function inWindow(instant: string, query: QueryContext): boolean {
  const timestamp = Date.parse(instant)
  return timestamp >= Date.parse(query.window.start) && timestamp < Date.parse(query.window.end)
}

function queryRecord(query: QueryContext): Record<string, unknown> {
  return { ...query, skuIds: [...query.skuIds], window: { ...query.window } }
}

export class ImportedDataAdapter implements CommerceAdapter {
  readonly #repository: DataGovernanceRepository
  readonly #evidence: EvidenceRepository
  readonly #binding: Binding

  constructor(options: {
    repository: DataGovernanceRepository
    evidence: EvidenceRepository
    binding: Binding
  }) {
    this.#repository = options.repository
    this.#evidence = options.evidence
    this.#binding = { ...options.binding }
  }

  async querySales(input: QueryContext, signal?: AbortSignal): Promise<ToolEnvelope<SalesRecord[]>> {
    const { query, snapshot, records } = await this.#load('sales', input, signal)
    const data = SalesRecordArraySchema.parse(records.map(row => row.payload)).filter(record => (
      query.skuIds.includes(record.skuId)
      && (inWindow(record.paidAt, query) || record.refunds.some(refund => inWindow(refund.refundedAt, query)))
    ))
    const selected = records.filter(record => data.some(item => item.lineId === record.sourceRecordId))
    return this.#envelope('query_sales', 'sales', query, snapshot, selected, data)
  }

  async queryInventory(input: QueryContext, signal?: AbortSignal): Promise<ToolEnvelope<InventorySnapshot[]>> {
    const { query, snapshot, records } = await this.#load('inventory', input, signal)
    const data = InventorySnapshotArraySchema.parse(records.map(row => row.payload)).filter(record => (
      query.skuIds.includes(record.skuId) && inWindow(record.observedAt, query)
    ))
    const selected = records.filter(record => data.some(item => item.snapshotId === record.sourceRecordId))
    return this.#envelope('query_inventory', 'inventory', query, snapshot, selected, data)
  }

  async queryPromotions(input: QueryContext, signal?: AbortSignal): Promise<ToolEnvelope<PromotionRecord[]>> {
    const { query, snapshot, records } = await this.#load('promotions', input, signal)
    const data = PromotionRecordArraySchema.parse(records.map(row => row.payload)).filter(record => (
      record.skuIds.some(skuId => query.skuIds.includes(skuId))
      && Date.parse(record.start) < Date.parse(query.window.end)
      && Date.parse(record.end) > Date.parse(query.window.start)
    ))
    const selected = records.filter(record => data.some(item => item.promotionId === record.sourceRecordId))
    return this.#envelope('query_promotions', 'promotions', query, snapshot, selected, data)
  }

  async queryAds(input: QueryContext, signal?: AbortSignal): Promise<ToolEnvelope<AdRecord[]>> {
    const { query, snapshot, records } = await this.#load('ads', input, signal)
    const data = AdRecordArraySchema.parse(records.map(row => row.payload)).filter(record => (
      query.skuIds.includes(record.skuId) && inWindow(record.observedAt, query)
    ))
    const selected = records.filter(record => data.some(item => item.recordId === record.sourceRecordId))
    return this.#envelope('query_ads', 'ads', query, snapshot, selected, data)
  }

  async queryProducts(input: QueryContext, signal?: AbortSignal): Promise<ToolEnvelope<ProductRecord[]>> {
    const { query, snapshot, records } = await this.#load('products', input, signal)
    const data = ProductRecordArraySchema.parse(records.map(row => row.payload)).filter(record => (
      query.skuIds.includes(record.skuId)
    ))
    const selected = records.filter(record => data.some(item => `${item.productId}:${item.skuId}` === record.sourceRecordId))
    return this.#envelope('query_products', 'products', query, snapshot, selected, data)
  }

  async #load(kind: DataKind, input: QueryContext, signal?: AbortSignal): Promise<{
    query: QueryContext
    snapshot: DataSnapshot
    records: DataRecordVersion[]
  }> {
    signal?.throwIfAborted()
    const query = QueryContextSchema.parse(input)
    if (query.shopId !== this.#binding.shopId) {
      throw new CommerceError('SCOPE_DENIED', 'Shop is outside the imported-data binding')
    }
    const snapshot = await this.#repository.getSnapshot(this.#binding)
    if (!snapshot) throw new CommerceError('NOT_FOUND', 'Bound data snapshot was not found')
    if (snapshot.tenantId !== this.#binding.tenantId || snapshot.shopId !== this.#binding.shopId) {
      throw new CommerceError('SCOPE_DENIED', 'Snapshot scope conflicts with the imported-data binding')
    }
    if (query.currency !== snapshot.currency) {
      throw new CommerceError('INVALID_ARGUMENT', `Snapshot currency is ${snapshot.currency}, received ${query.currency}`)
    }
    const records = await this.#repository.listSnapshotRecords({ ...this.#binding, kind })
    signal?.throwIfAborted()
    return { query, snapshot, records }
  }

  #envelope<T>(
    tool: string,
    kind: DataKind,
    query: QueryContext,
    snapshot: DataSnapshot,
    records: DataRecordVersion[],
    data: T,
  ): ToolEnvelope<T> {
    const sources = [...new Map(records.map(record => [
      `${record.sourceType}:${record.sourceId}:${record.importId}`,
      { sourceType: record.sourceType, sourceId: record.sourceId, importId: record.importId },
    ])).values()]
    const sourceLabel = sources.length === 1 ? sources[0]!.sourceId : 'mixed'
    const source = `import:${sourceLabel}:snapshot:${snapshot.snapshotId}`
    const completeness = snapshot.completeness[kind]
    const warning = completeness === 'complete'
      ? []
      : [`${kind} source completeness is ${completeness} for snapshot ${snapshot.snapshotId}.`]
    if (records.length === 0 && completeness === 'complete') {
      warning.push('No records matched the requested scope and time range.')
    }
    const evidence = this.#evidence.capture({
      tool,
      source,
      asOf: query.asOf,
      traceId: query.traceId,
      query: queryRecord(query),
      recordRefs: records.map(record => record.recordVersionId),
      content: data,
      summary: `${tool} returned ${records.length} governed record(s) from ${snapshot.snapshotId}`,
      governance: {
        schemaVersion: 2,
        tenantId: snapshot.tenantId,
        shopId: snapshot.shopId,
        snapshotId: snapshot.snapshotId,
        sourceType: snapshot.sourceType,
        sources,
        sourceRecordIds: records.map(record => record.sourceRecordId).sort(),
        metricDefinitionVersion: snapshot.metricDefinitionVersion,
        contentHash: contentHash(records.map(record => ({
          recordVersionId: record.recordVersionId,
          contentHash: record.contentHash,
        }))),
        businessTimeRange: { start: query.window.start, end: query.window.end },
        ingestedAt: snapshot.createdAt,
      },
    })
    return {
      status: completeness !== 'complete' ? 'partial' : records.length === 0 ? 'missing' : 'ok',
      data,
      source,
      asOf: query.asOf,
      query,
      traceId: query.traceId,
      evidence: [evidence],
      warnings: warning,
    }
  }
}
