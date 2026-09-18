import type {
  AdRecord,
  InventorySnapshot,
  ProductRecord,
  PromotionRecord,
  QueryContext,
  SalesRecord,
  ToolEnvelope,
} from '../domain/contracts.ts'

/** Read-only commerce data boundary used by tools. Implementations must enforce scope. */
export interface CommerceAdapter {
  querySales(input: QueryContext, signal?: AbortSignal): Promise<ToolEnvelope<SalesRecord[]>>
  queryInventory(input: QueryContext, signal?: AbortSignal): Promise<ToolEnvelope<InventorySnapshot[]>>
  queryPromotions(input: QueryContext, signal?: AbortSignal): Promise<ToolEnvelope<PromotionRecord[]>>
  queryAds(input: QueryContext, signal?: AbortSignal): Promise<ToolEnvelope<AdRecord[]>>
  queryProducts(input: QueryContext, signal?: AbortSignal): Promise<ToolEnvelope<ProductRecord[]>>
}
