import type { EvidenceRecord, EvidenceRef, ToolEnvelope } from '../domain/contracts.ts'
import { CommerceError } from '../domain/errors.ts'
import { GetEvidenceInputSchema, toQueryContext } from '../mcp/schemas.ts'
import type { ToolExecutionContext } from '../mcp/tool-runner.ts'
import type { CommerceToolDependencies } from './context.ts'

function assertEvidenceScope(record: EvidenceRecord, shopId: string, skuIds: string[]): void {
  const evidenceShopId = record.query.shopId
  const evidenceSkuIds = record.query.skuIds
  if (evidenceShopId !== shopId || !Array.isArray(evidenceSkuIds)) {
    throw new CommerceError('NOT_FOUND', `Evidence not found in requested scope: ${record.evidenceId}`)
  }
  const allowed = new Set(skuIds)
  if (!(evidenceSkuIds as unknown[]).every(skuId => typeof skuId === 'string' && allowed.has(skuId))) {
    throw new CommerceError('NOT_FOUND', `Evidence not found in requested scope: ${record.evidenceId}`)
  }
}

export async function getEvidenceTool(
  rawArgs: Record<string, unknown>,
  execution: ToolExecutionContext,
  dependencies: CommerceToolDependencies,
): Promise<ToolEnvelope<EvidenceRecord>> {
  const input = GetEvidenceInputSchema.parse(rawArgs)
  const query = toQueryContext(input, execution.traceId, dependencies.now)
  const record = dependencies.evidence.getOrThrow(input.evidence_id)
  assertEvidenceScope(record, query.shopId, query.skuIds)
  const ref: EvidenceRef = {
    evidenceId: record.evidenceId,
    source: record.source,
    locator: record.recordRefs.length > 0 ? record.recordRefs.join(',') : 'empty-result',
    traceId: execution.traceId,
  }
  return {
    status: 'ok',
    data: record,
    source: record.source,
    asOf: query.asOf,
    query,
    traceId: execution.traceId,
    evidence: [ref],
    warnings: [],
  }
}
