# Metric definitions

- Time windows are half-open: `[start, end)`. Baseline and current windows must use the same timezone and duration.
- Monetary values use integer minor units. `CNY_minor` means fen; do not combine currencies.
- Net sales = paid GMV minus refunds occurring in the selected window.
- Contribution = net sales - product cost - platform fee - fulfillment cost. Contribution rate = contribution / net sales.
- Inventory coverage days = latest available quantity / average daily sold units. A null denominator is unknown, not infinity.
- CTR = clicks / impressions. CVR = attributed orders / clicks. CPC = spend / clicks. ROAS = attributed revenue / spend.
- Advertising attribution window is a data property. If it differs from the sales comparison window, disclose the mismatch and lower confidence.
- All derived values inherit the evidence IDs of their source records.
