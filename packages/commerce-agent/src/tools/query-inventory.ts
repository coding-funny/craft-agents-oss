import type { InventorySnapshot, ToolEnvelope } from '../domain/contracts.ts'
import { QueryToolInputSchema, toQueryContext } from '../mcp/schemas.ts'
import type { ToolExecutionContext } from '../mcp/tool-runner.ts'
import { calculateInventoryMetrics, type InventoryMetrics } from '../metrics/inventory.ts'
import { mergeEvidence } from '../metrics/common.ts'
import { calculateSalesMetrics } from '../metrics/sales.ts'
import type { CommerceToolDependencies } from './context.ts'

export type QueryInventoryData = {
  snapshots: InventorySnapshot[]
  metrics: InventoryMetrics
}

export async function queryInventoryTool(
  rawArgs: Record<string, unknown>,
  execution: ToolExecutionContext,
  dependencies: CommerceToolDependencies,
): Promise<ToolEnvelope<QueryInventoryData>> {
  const input = QueryToolInputSchema.parse(rawArgs)
  const query = toQueryContext(input, execution.traceId, dependencies.now)
  const [inventory, sales] = await Promise.all([
    dependencies.adapter.queryInventory(query, execution.signal),
    dependencies.adapter.querySales(query, execution.signal),
  ])
  const salesMetrics = calculateSalesMetrics(sales.data, query.window, sales.evidence)
  const metrics = calculateInventoryMetrics(inventory.data, salesMetrics, query.window, inventory.evidence)
  return {
    ...inventory,
    source: `${inventory.source}+${sales.source}`,
    data: { snapshots: inventory.data, metrics },
    evidence: mergeEvidence(inventory.evidence, sales.evidence),
    warnings: [...inventory.warnings, ...sales.warnings],
  }
}
