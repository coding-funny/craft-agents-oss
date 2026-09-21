import type { DiagnosisReportDraft } from './schema.ts'

function evidence(ids: string[]): string {
  return ids.map(id => `\`${id}\``).join(', ')
}

export function renderReport(report: DiagnosisReportDraft, reportId: string): string {
  const lines = [
    `# Commerce diagnosis ${reportId}`,
    '',
    `- Trace: \`${report.traceId}\``,
    `- Case: \`${report.caseId}\``,
    `- Status: \`${report.status}\``,
    `- Scope: ${report.scope.shopId} / ${report.scope.skuIds.join(', ')} / ${report.scope.currency}`,
    `- Baseline: ${report.scope.baselineWindow.start} — ${report.scope.baselineWindow.end}`,
    `- Current: ${report.scope.currentWindow.start} — ${report.scope.currentWindow.end}`,
    '',
    '## Executive summary',
    '',
    `${report.executiveSummary.statement} (${evidence(report.executiveSummary.evidenceIds)})`,
    '',
    '## KPI comparison',
    '',
    '| KPI | Baseline | Current | Change |',
    '| --- | ---: | ---: | ---: |',
    ...report.kpis.map(kpi => `| ${kpi.name} | ${kpi.baseline.value ?? 'N/A'} ${kpi.baseline.unit} | ${kpi.current.value ?? 'N/A'} ${kpi.current.unit} | ${kpi.changeRate ?? 'N/A'} |`),
    '',
    '## Anomalies',
    '',
    ...report.anomalies.map(item => `- ${item.statement} (${evidence(item.evidenceIds)})`),
    '',
    '## Hypotheses',
    '',
    ...report.hypotheses.map(item => `- **${item.confidence} ${item.confidenceScore.toFixed(2)}** ${item.statement}; counter-evidence: ${item.counterEvidenceIds.length ? evidence(item.counterEvidenceIds) : 'none'}; limitations: ${item.limitations.join('; ') || 'none'}`),
    '',
    '## Risks and unknowns',
    '',
    ...report.risks.map(item => `- Risk: ${item}`),
    ...report.unknowns.map(item => `- Unknown: ${item.statement}; required data: ${item.requiredData}`),
    '',
    '## Recommendations',
    '',
    ...report.recommendations.map(item => `- **${item.riskLevel}** [${item.recommendationId}] ${item.action} — ${item.rationale} (${evidence(item.evidenceIds)})${item.proposalDraft ? `\n  - Proposal draft: ${item.proposalDraft}` : ''}\n  - Action draft: ${item.actionDraft.actionType} on \`${item.actionDraft.targetId}\`; parameters: \`${JSON.stringify(item.actionDraft.parameters)}\`; preconditions: ${item.actionDraft.preconditions.join('; ')}; rollback: ${item.actionDraft.rollbackPlan}`),
    '',
    '## Evidence',
    '',
    ...report.evidence.map(item => `- \`${item.evidenceId}\` — ${item.source}, as of ${item.asOf}: ${item.summary}`),
    '',
    '> This report contains analysis and proposal drafts only. It does not execute commercial actions.',
    '',
  ]
  return lines.join('\n')
}
