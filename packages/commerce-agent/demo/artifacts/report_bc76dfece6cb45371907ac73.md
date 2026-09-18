# Commerce diagnosis report_bc76dfece6cb45371907ac73

- Trace: `trace-inventory-shortage-001`
- Case: `inventory-shortage`
- Status: `NEEDS_DATA`
- Scope: demo-shop / SKU-A / CNY
- Baseline: 2026-09-01T00:00:00+08:00 — 2026-09-08T00:00:00+08:00
- Current: 2026-09-08T00:00:00+08:00 — 2026-09-15T00:00:00+08:00

## Executive summary

The strongest observed constraint is inventory availability alongside lower net sales. (`ev_b089bb5e0593984d6a15db89`, `ev_7b0464237e3fbed640606b8d`, `ev_23ee813def55a6a434e083be`)

## KPI comparison

| KPI | Baseline | Current | Change |
| --- | ---: | ---: | ---: |
| net_sales | 200000 CNY_minor | 110000 CNY_minor | -0.45 |
| stockout_sku_count | 0 skus | 1 skus | N/A |

## Anomalies

- Net sales decreased while the latest inventory evidence contains a stockout snapshot. (`ev_b089bb5e0593984d6a15db89`, `ev_7b0464237e3fbed640606b8d`, `ev_23ee813def55a6a434e083be`)

## Hypotheses

- **HIGH 0.77** Inventory availability is associated with the observed sales decline; promotion evidence does not remove that constraint.; counter-evidence: `ev_42ab2cf7f7e3dde384c75444`; limitations: Advertising attribution is unavailable for this SKU and period.; The evidence supports association, not proven causality.

## Risks and unknowns

- Risk: Fixture evidence demonstrates the workflow but is not production platform data.
- Risk: Advertising effects cannot be separated from organic demand with the available evidence.
- Unknown: Advertising attribution data is missing for at least one comparison window.; required data: SKU-level impressions, clicks, spend, attributed orders, revenue, and attribution-window definition.

## Recommendations

- **HIGH** [rec-inventory-replenishment] Prepare a replenishment proposal and review inbound lead time before any inventory commitment. — The current window includes stockout evidence and lower net sales. (`ev_b089bb5e0593984d6a15db89`, `ev_7b0464237e3fbed640606b8d`, `ev_23ee813def55a6a434e083be`)
  - Proposal draft: Proposed only: restore a review-approved safety stock after validating forecast and supplier lead time.
  - Action draft: CREATE_REPLENISHMENT_TASK on `SKU-A`; parameters: `{"requestedQty":50}`; preconditions: Latest available inventory remains zero.; Supplier lead time is reviewed by an operator.; rollback: Cancel the mock replenishment task before fulfillment begins.

## Evidence

- `ev_23ee813def55a6a434e083be` — fixture-v1/inventory.json, as of 2026-09-15T09:00:00+08:00: query_inventory returned 4 fixture record(s)
- `ev_42ab2cf7f7e3dde384c75444` — fixture-v1/promotions.json, as of 2026-09-15T09:00:00+08:00: query_promotions returned 1 fixture record(s)
- `ev_7b0464237e3fbed640606b8d` — fixture-v1/sales.json, as of 2026-09-15T09:00:00+08:00: query_sales returned 5 fixture record(s)
- `ev_b089bb5e0593984d6a15db89` — fixture-v1/sales.json, as of 2026-09-15T09:00:00+08:00: query_sales returned 2 fixture record(s)
- `ev_b4ab5f5d02cc4ecdbac63e1e` — fixture-v1/inventory.json, as of 2026-09-15T09:00:00+08:00: query_inventory returned 2 fixture record(s)

> This report contains analysis and proposal drafts only. It does not execute commercial actions.
