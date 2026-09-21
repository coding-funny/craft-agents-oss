---
name: "Commerce Diagnosis"
description: "Investigate sales, inventory, promotion, margin, and advertising anomalies, then persist an evidence-gated commerce diagnosis report."
requiredSources:
  - commerce
---

# Commerce Diagnosis

Use this Skill only for evidence-backed commerce diagnosis. The host invocation must include `commerce-diagnosis` in `skillSlugs`; this Skill requires the `commerce` Source declared in frontmatter.

## Tool whitelist

You may use only these Source tools: `query_sales`, `query_inventory`, `query_promotions`, `compute_margin`, `query_ads`, `get_evidence`, `validate_report`, `create_proposal`, and `get_proposal`. Approval, rejection, and execution are operator-only CLI actions.

## Workflow

1. Confirm shop, SKU scope, current window, equal-length baseline window, timezone, observation cutoff, and currency.
2. Query sales first. Treat returned metrics as observations, not root causes.
3. Investigate the anomalous SKU and aligned windows with inventory, promotion, margin, and advertising evidence. Read [metric definitions](references/metric-definitions.md).
4. Follow the branching rules in [diagnosis playbook](references/diagnosis-playbook.md). Preserve conflicts and missing data. Never replace missing attribution with zero.
5. Separate `FACT`, `HYPOTHESIS`, `RECOMMENDATION`, and unknown items. Every summary, KPI, anomaly, hypothesis, and recommendation must cite repository-backed `evidence_id` values.
6. Advertising comparisons must use the same SKU and reporting windows. Compare CTR, CVR, spend, ROAS, and sales; disclose any attribution-window mismatch.
7. Build the exact report object described by [report template](references/report-template.md), then call `validate_report`. A chat response or accepted message is not completion.
8. Finish only after `validate_report` returns a readable `report_id`. Return that ID, the trace ID, status, main finding, confidence, unknowns, and proposal-only recommendations.
9. Create a Proposal only when the user asks and the report status is `RESOLVED`; report the resulting `PENDING_APPROVAL` state and wait for an operator.

## Reasoning boundaries

- Correlation is not proven causality. Use “associated with” or “coincides with” unless causal evidence exists.
- Conflicting evidence lowers confidence and remains visible as counter-evidence.
- Missing critical attribution produces `NEEDS_DATA` or a low-confidence hypothesis.
- A high-risk recommendation must be a proposal draft. Never describe it as executed.
- Do not place recommendations in the fact section or silently repair invalid evidence.
