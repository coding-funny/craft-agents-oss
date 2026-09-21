import type { EvidenceRef, ToolEnvelope } from '../domain/contracts.ts'
import type { ToolExecutionContext } from '../mcp/tool-runner.ts'
import { ValidateReportInputSchema } from '../mcp/schemas.ts'
import { validateAndPersistReport } from '../reports/validate-report.ts'
import type { CommerceToolDependencies } from './context.ts'

export async function validateReportTool(
  rawArgs: Record<string, unknown>,
  execution: ToolExecutionContext,
  dependencies: CommerceToolDependencies,
): Promise<ToolEnvelope<{ reportId: string; jsonPath: string; markdownPath: string }>> {
  const input = ValidateReportInputSchema.parse(rawArgs)
  const persisted = await validateAndPersistReport(input.report, dependencies.evidence, dependencies.reports)
  const report = persisted.report
  const evidence: EvidenceRef[] = report.evidence.map(item => ({
    evidenceId: item.evidenceId,
    source: item.source,
    locator: 'validated-report-reference',
    traceId: execution.traceId,
  }))
  return {
    status: 'ok',
    data: {
      reportId: report.reportId,
      jsonPath: persisted.jsonPath,
      markdownPath: persisted.markdownPath,
    },
    source: 'commerce-report-validator-v1',
    asOf: report.generatedAt,
    query: {
      runId: report.caseId,
      caseId: report.caseId,
      traceId: execution.traceId,
      shopId: report.scope.shopId,
      skuIds: report.scope.skuIds,
      window: report.scope.currentWindow,
      asOf: report.generatedAt,
      currency: report.scope.currency,
    },
    traceId: execution.traceId,
    evidence,
    warnings: [],
  }
}
