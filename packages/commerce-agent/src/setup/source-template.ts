import { resolve } from 'node:path'

export const COMMERCE_SOURCE_SLUG = 'commerce'
export const COMMERCE_DIAGNOSIS_SKILL_SLUG = 'commerce-diagnosis'
export const AGENT_TOOL_PATTERN = '(query_sales|query_inventory|query_promotions|compute_margin|query_ads|get_evidence|validate_report|create_proposal|get_proposal)$'

export type SourceTemplateOptions = {
  workspaceRoot: string
  repoRoot: string
  bunPath: string
}

export type SourceTemplateFiles = Record<string, string>

export function buildCommerceSourceFiles(options: SourceTemplateOptions): SourceTemplateFiles {
  const sourceDir = `sources/${COMMERCE_SOURCE_SLUG}`
  const serverPath = resolve(options.repoRoot, 'packages/commerce-agent/src/mcp/server.ts')
  const fixtureDir = resolve(options.repoRoot, 'packages/commerce-agent/fixtures')
  const traceFile = resolve(options.workspaceRoot, '.commerce/traces.jsonl')
  const reportDir = resolve(options.workspaceRoot, '.commerce/reports')
  const dbPath = resolve(options.workspaceRoot, '.commerce/commerce.sqlite')
  const config = {
    id: 'commerce-demo-source',
    name: 'Commerce Demo',
    slug: COMMERCE_SOURCE_SLUG,
    enabled: true,
    provider: 'commerce-demo',
    type: 'mcp',
    icon: '🛒',
    tagline: '查询演示店铺经营数据并创建受人工审批约束的 Mock 提案',
    mcp: {
      transport: 'stdio',
      command: options.bunPath,
      args: ['run', serverPath],
      env: {
        COMMERCE_MODE: 'governed-mock',
        COMMERCE_SHOP_ID: 'demo-shop',
        COMMERCE_FIXTURE_DIR: fixtureDir,
        COMMERCE_TRACE_FILE: traceFile,
        COMMERCE_REPORT_DIR: reportDir,
        COMMERCE_DB_PATH: dbPath,
      },
    },
  }
  const permissions = {
    allowedMcpPatterns: [AGENT_TOOL_PATTERN],
    allowedBashPatterns: [],
    allowedApiEndpoints: [],
    allowedWritePaths: [],
    blockedCommandHints: [],
  }
  const guide = `# Commerce Demo

访问固定演示店铺的只读经营数据，并将已通过门禁的建议登记为待人工审批 Proposal。当前 Source 不包含审批、改价、调预算或其他商业写操作。

## Scope

- 店铺：\`demo-shop\`
- 币种：CNY，金额单位为分
- 时间窗口：\`[start, end)\`
- 数据源：固定 Fixture，仅用于可复现开发与评测

## Guidelines

1. 每次查询必须提供 \`run_id\`、\`case_id\`、SKU 和带时区的时间窗口。
2. 使用 \`query_sales\`、\`query_inventory\`、\`query_promotions\`、\`compute_margin\`、\`query_ads\` 获取经营证据。
3. 使用 \`get_evidence\` 按原店铺和 SKU 范围复核证据。
4. 用 \`validate_report\` 完成证据、数值、口径和持久化门禁；只有返回可读取的 \`report_id\` 才算完成。
5. 仅对 \`RESOLVED\` 报告使用 \`create_proposal\`，再用 \`get_proposal\` 查看状态。批准、拒绝与执行由独立人工 CLI 完成。
6. 缺失结果不能替换为有效零值；多币种不得直接合并。
7. 工具返回的是事实和确定性指标，不代表已经证明现实因果。

## Read-only guarantee

本 Source 注册查询、计算、报告校验和提案记录工具。批准、拒绝、执行和真实平台写入不在模型工具集中。
`
  const skill = `---
name: "Commerce Diagnosis"
description: "Investigate sales, inventory, promotion, margin, and advertising anomalies, then persist an evidence-gated commerce diagnosis report."
requiredSources:
  - commerce
---

# Commerce Diagnosis

Use this Skill only for evidence-backed commerce diagnosis. The host invocation must include \`commerce-diagnosis\` in \`skillSlugs\`; this Skill requires the \`commerce\` Source declared in frontmatter.

## Tool whitelist

You may use only these Source tools: \`query_sales\`, \`query_inventory\`, \`query_promotions\`, \`compute_margin\`, \`query_ads\`, \`get_evidence\`, \`validate_report\`, \`create_proposal\`, and \`get_proposal\`. Approval, rejection, and execution are operator-only CLI actions.

## Workflow

1. Confirm shop, SKU scope, current window, equal-length baseline window, timezone, observation cutoff, and currency.
2. Query sales first. Treat returned metrics as observations, not root causes.
3. Investigate the anomalous SKU and aligned windows with inventory, promotion, margin, and advertising evidence. Read [metric definitions](references/metric-definitions.md).
4. Follow the branching rules in [diagnosis playbook](references/diagnosis-playbook.md). Preserve conflicts and missing data. Never replace missing attribution with zero.
5. Separate \`FACT\`, \`HYPOTHESIS\`, \`RECOMMENDATION\`, and unknown items. Every summary, KPI, anomaly, hypothesis, and recommendation must cite repository-backed \`evidence_id\` values.
6. Advertising comparisons must use the same SKU and reporting windows. Compare CTR, CVR, spend, ROAS, and sales; disclose any attribution-window mismatch.
7. Build the exact report object described by [report template](references/report-template.md), then call \`validate_report\`. A chat response or accepted message is not completion.
8. Finish only after \`validate_report\` returns a readable \`report_id\`. Return that ID, the trace ID, status, main finding, confidence, unknowns, and proposal-only recommendations.
9. Create a Proposal only when the user asks and the report status is \`RESOLVED\`; report the resulting \`PENDING_APPROVAL\` state and wait for an operator.

## Reasoning boundaries

- Correlation is not proven causality. Use “associated with” or “coincides with” unless causal evidence exists.
- Conflicting evidence lowers confidence and remains visible as counter-evidence.
- Missing critical attribution produces \`NEEDS_DATA\` or a low-confidence hypothesis.
- A high-risk recommendation must be a proposal draft. Never describe it as executed.
- Do not place recommendations in the fact section or silently repair invalid evidence.
`
  const metricDefinitions = `# Metric definitions

- Time windows are half-open: \`[start, end)\`. Baseline and current windows must use the same timezone and duration.
- Monetary values use integer minor units. \`CNY_minor\` means fen; do not combine currencies.
- Net sales = paid GMV minus refunds occurring in the selected window.
- Contribution = net sales - product cost - platform fee - fulfillment cost. Contribution rate = contribution / net sales.
- Inventory coverage days = latest available quantity / average daily sold units. A null denominator is unknown, not infinity.
- CTR = clicks / impressions. CVR = attributed orders / clicks. CPC = spend / clicks. ROAS = attributed revenue / spend.
- Advertising attribution window is a data property. If it differs from the sales comparison window, disclose the mismatch and lower confidence.
- All derived values inherit the evidence IDs of their source records.
`
  const diagnosisPlaybook = `# Diagnosis playbook

## Required sequence

1. Detect the change in net sales, orders, units, and refunds.
2. Check inventory snapshots and coverage for constrained supply.
3. Check promotion sponsor, stacking rule, and contribution economics.
4. Check advertising spend, CTR, CVR, ROAS, and attribution-window alignment.
5. Compare supporting evidence, counter-evidence, and missing data before assigning confidence.

## Branches

- Spend rises and CVR/ROAS falls: investigate paid-traffic efficiency; do not claim advertising alone caused total sales decline.
- Clicks rise while inventory is constrained: keep both observations and prioritize stock availability as a limiting hypothesis.
- Advertising remains stable while total sales falls: report that organic traffic data is required before explaining the gap.
- Attribution is missing: mark advertising analysis as evidence-insufficient; never turn missing into zero.
- Promotion lifts units but contribution rate falls: produce a discount/funding proposal only after showing both sales and margin evidence.

Recommendations are review inputs. They do not authorize execution.
`
  const reportTemplate = `# Report Artifact contract

Pass one strict object to \`validate_report\` with these camelCase sections:

- \`traceId\`, \`caseId\`, \`generatedAt\`, \`status\`
- \`scope\`: shopId, skuIds, baselineWindow, currentWindow, currency
- \`executiveSummary\`: statement and evidenceIds
- \`kpis\`: name, baseline/current value, unit, evidenceIds, and changeRate
- \`anomalies\`: \`kind: FACT\`, statement, evidenceIds
- \`hypotheses\`: \`kind: HYPOTHESIS\`, confidence, score, support, counter-evidence, limitations
- \`evidence\`: evidenceId, source, asOf, summary copied from resolved evidence
- \`risks\`, \`unknowns\`, and \`recommendations\`

Each recommendation must use \`kind: RECOMMENDATION\`, include a stable \`recommendationId\`, evidence, and an \`actionDraft\` with \`actionType\`, \`targetId\`, typed parameters, preconditions, expected impact, and rollback plan. High-risk recommendations require \`proposalDraft\`. The validator recomputes supported KPI values from raw Evidence, verifies baseline/current period ownership, assigns \`report_id\`, persists JSON and Markdown, rereads the JSON, and rejects value, period, scope, currency, unit, evidence, certainty, or persistence failures.
`

  return {
    [`${sourceDir}/config.json`]: `${JSON.stringify(config, null, 2)}\n`,
    [`${sourceDir}/guide.md`]: guide,
    [`${sourceDir}/permissions.json`]: `${JSON.stringify(permissions, null, 2)}\n`,
    [`skills/${COMMERCE_DIAGNOSIS_SKILL_SLUG}/SKILL.md`]: skill,
    [`skills/${COMMERCE_DIAGNOSIS_SKILL_SLUG}/references/metric-definitions.md`]: metricDefinitions,
    [`skills/${COMMERCE_DIAGNOSIS_SKILL_SLUG}/references/diagnosis-playbook.md`]: diagnosisPlaybook,
    [`skills/${COMMERCE_DIAGNOSIS_SKILL_SLUG}/references/report-template.md`]: reportTemplate,
  }
}
