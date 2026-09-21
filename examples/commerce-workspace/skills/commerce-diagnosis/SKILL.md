---
name: "Commerce Diagnosis"
description: "Investigate sales, inventory, promotion, margin, and advertising anomalies, then persist an evidence-gated commerce diagnosis report."
requiredSources:
  - commerce
---

# Commerce Diagnosis

The host invocation must include `commerce-diagnosis` in `skillSlugs`. This Skill requires the `commerce` Source declared in frontmatter.

## Tool whitelist

Use only `query_sales`, `query_inventory`, `query_promotions`, `compute_margin`, `query_ads`, `get_evidence`, `validate_report`, `create_proposal`, and `get_proposal`. Approval, rejection, execution, and reconciliation are operator-only CLI actions.

## Workflow

1. Confirm shop, SKU scope, current and equal-length baseline windows, timezone, observation cutoff, and currency.
2. Query sales first; observations are not root causes.
3. Investigate the same SKU and aligned windows with inventory, promotion, margin, and advertising evidence. Read [metric definitions](references/metric-definitions.md).
4. Follow [diagnosis playbook](references/diagnosis-playbook.md). Preserve conflicts and missing data; never replace missing attribution with zero.
5. Separate facts, hypotheses, recommendations, and unknowns. Every key item must cite repository-backed evidence IDs.
6. Compare advertising CTR, CVR, CPC, spend, ROAS, and sales, disclosing attribution-window mismatch.
7. Build [the report contract](references/report-template.md), then call `validate_report`.
8. Finish only after validation returns a readable `report_id`. A chat response is not completion.
9. Create a Proposal only when requested and the report is `RESOLVED`; return its `PENDING_APPROVAL` state for operator review.

Correlation is not proven causality. Conflicts lower confidence. High-risk actions remain proposal drafts and are never executed.
