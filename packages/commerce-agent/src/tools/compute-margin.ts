import type { ToolEnvelope } from '../domain/contracts.ts'
import { QueryToolInputSchema, toQueryContext } from '../mcp/schemas.ts'
import type { ToolExecutionContext } from '../mcp/tool-runner.ts'
import { mergeEvidence } from '../metrics/common.ts'
import { calculateMarginMetrics, type MarginMetrics } from '../metrics/margin.ts'
import type { CommerceToolDependencies } from './context.ts'

export async function computeMarginTool(
  rawArgs: Record<string, unknown>,
  execution: ToolExecutionContext,
  dependencies: CommerceToolDependencies,
): Promise<ToolEnvelope<MarginMetrics>> {
  const input = QueryToolInputSchema.parse(rawArgs)
  const query = toQueryContext(input, execution.traceId, dependencies.now)
  const [sales, products] = await Promise.all([
    dependencies.adapter.querySales(query, execution.signal),
    dependencies.adapter.queryProducts(query, execution.signal),
  ])
  const evidence = mergeEvidence(sales.evidence, products.evidence)
  return {
    status: sales.status === 'missing' || products.status === 'missing' ? 'missing' : 'ok',
    data: calculateMarginMetrics(sales.data, products.data, query.window, evidence),
    source: `${sales.source}+${products.source}`,
    asOf: query.asOf,
    query,
    traceId: execution.traceId,
    evidence,
    warnings: [...sales.warnings, ...products.warnings],
  }
}
