import type { PromotionRecord, ToolEnvelope } from '../domain/contracts.ts'
import { QueryToolInputSchema, toQueryContext } from '../mcp/schemas.ts'
import type { ToolExecutionContext } from '../mcp/tool-runner.ts'
import type { CommerceToolDependencies } from './context.ts'

export async function queryPromotionsTool(
  rawArgs: Record<string, unknown>,
  execution: ToolExecutionContext,
  dependencies: CommerceToolDependencies,
): Promise<ToolEnvelope<PromotionRecord[]>> {
  const input = QueryToolInputSchema.parse(rawArgs)
  const query = toQueryContext(input, execution.traceId, dependencies.now)
  return dependencies.adapter.queryPromotions(query, execution.signal)
}
