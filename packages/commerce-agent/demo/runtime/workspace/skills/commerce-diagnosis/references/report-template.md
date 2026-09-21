# Report Artifact contract

Pass one strict object to `validate_report` with these camelCase sections:

- `traceId`, `caseId`, `generatedAt`, `status`
- `scope`: shopId, skuIds, baselineWindow, currentWindow, currency
- `executiveSummary`: statement and evidenceIds
- `kpis`: name, baseline/current value, unit, evidenceIds, and changeRate
- `anomalies`: `kind: FACT`, statement, evidenceIds
- `hypotheses`: `kind: HYPOTHESIS`, confidence, score, support, counter-evidence, limitations
- `evidence`: evidenceId, source, asOf, summary copied from resolved evidence
- `risks`, `unknowns`, and `recommendations`

Each recommendation must use `kind: RECOMMENDATION`, include a stable `recommendationId`, evidence, and an `actionDraft` with `actionType`, `targetId`, typed parameters, preconditions, expected impact, and rollback plan. High-risk recommendations require `proposalDraft`. The validator recomputes supported KPI values from raw Evidence, verifies baseline/current period ownership, assigns `report_id`, persists JSON and Markdown, rereads the JSON, and rejects value, period, scope, currency, unit, evidence, certainty, or persistence failures.
