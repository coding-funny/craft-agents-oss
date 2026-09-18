import type { EvidenceRef, ToolEnvelope } from '../domain/contracts.ts'
import { CommerceError } from '../domain/errors.ts'
import { CreateProposalInputSchema } from '../mcp/schemas.ts'
import type { ToolExecutionContext } from '../mcp/tool-runner.ts'
import type { CommerceToolDependencies } from './context.ts'

export async function createProposalTool(
  rawArgs: Record<string, unknown>,
  execution: ToolExecutionContext,
  dependencies: CommerceToolDependencies,
): Promise<ToolEnvelope<ReturnType<CommerceToolDependencies['proposals']['get']>>> {
  const input = CreateProposalInputSchema.parse(rawArgs)
  const report = await dependencies.reports.get(input.report_id)
  if (input.trace_id !== report.traceId) {
    throw new CommerceError('INVALID_ARGUMENT', 'trace_id must match the source report traceId')
  }
  const proposal = await dependencies.proposals.create({
    reportId: input.report_id,
    recommendationId: input.recommendation_id,
    expiresAt: input.expires_at,
  })
  const evidence: EvidenceRef[] = proposal.evidenceIds.map(evidenceId => {
    const record = dependencies.evidence.getOrThrow(evidenceId)
    return { evidenceId, source: record.source, locator: record.recordRefs.join(',') || 'empty-result', traceId: execution.traceId }
  })
  return {
    status: 'ok',
    data: proposal,
    source: 'commerce-proposal-store-v1',
    asOf: dependencies.now().toISOString(),
    query: {
      runId: report.caseId, caseId: report.caseId, traceId: execution.traceId,
      shopId: report.scope.shopId, skuIds: report.scope.skuIds, window: report.scope.currentWindow,
      asOf: report.generatedAt, currency: report.scope.currency,
    },
    traceId: execution.traceId,
    evidence,
    warnings: [],
  }
}
