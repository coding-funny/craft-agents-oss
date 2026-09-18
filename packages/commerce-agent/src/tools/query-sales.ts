import type { ToolEnvelope } from '../domain/contracts.ts'
import { QueryToolInputSchema, toQueryContext } from '../mcp/schemas.ts'
import type { ToolExecutionContext } from '../mcp/tool-runner.ts'
import { calculateSalesMetrics, type SalesMetrics } from '../metrics/sales.ts'
import type { CommerceToolDependencies } from './context.ts'

export type QuerySalesData = {
  records: Awaited<ReturnType<CommerceToolDependencies['adapter']['querySales']>>['data']
  metrics: SalesMetrics
}

export async function querySalesTool(
  rawArgs: Record<string, unknown>,
  execution: ToolExecutionContext,
  dependencies: CommerceToolDependencies,
): Promise<ToolEnvelope<QuerySalesData>> {
  const input = QueryToolInputSchema.parse(rawArgs)
  const query = toQueryContext(input, execution.traceId, dependencies.now)
  const result = await dependencies.adapter.querySales(query, execution.signal)
  const metrics = calculateSalesMetrics(result.data, query.window, result.evidence)
  return {
    ...result,
    data: { records: result.data, metrics },
  }
}
