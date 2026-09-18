import type { AdRecord, ToolEnvelope } from '../domain/contracts.ts'
import { QueryToolInputSchema, toQueryContext } from '../mcp/schemas.ts'
import type { ToolExecutionContext } from '../mcp/tool-runner.ts'
import { calculateAdMetrics, type AdMetrics } from '../metrics/ads.ts'
import type { CommerceToolDependencies } from './context.ts'

export type QueryAdsData = {
  records: AdRecord[]
  metrics: AdMetrics
}

export async function queryAdsTool(
  rawArgs: Record<string, unknown>,
  execution: ToolExecutionContext,
  dependencies: CommerceToolDependencies,
): Promise<ToolEnvelope<QueryAdsData>> {
  const input = QueryToolInputSchema.parse(rawArgs)
  const query = toQueryContext(input, execution.traceId, dependencies.now)
  const result = await dependencies.adapter.queryAds(query, execution.signal)
  const metrics = calculateAdMetrics(result.data, result.evidence)
  return {
    ...result,
    data: { records: result.data, metrics },
  }
}
