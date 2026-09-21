# Report Artifact contract

Pass one strict camelCase object to `validate_report`:

- traceId, caseId, generatedAt, status;
- scope with shop, SKU, baseline/current windows, and currency;
- evidence-cited executiveSummary and KPI comparisons;
- FACT anomalies and HYPOTHESIS items with confidence, support, counter-evidence, and limitations;
- resolved evidence metadata, risks, unknowns, and separate RECOMMENDATION items.

Every recommendation includes a stable recommendation ID and structured action draft with action type, target, parameters, preconditions, expected impact, and rollback plan. High-risk recommendations also require `proposalDraft`. The validator assigns `report_id`, persists JSON and Markdown, rereads the JSON, and rejects invalid evidence, values, periods, scope, currency, unit, certainty, or persistence.
