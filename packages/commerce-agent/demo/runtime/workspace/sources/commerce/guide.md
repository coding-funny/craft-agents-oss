# Commerce Demo

访问固定演示店铺的只读经营数据，并将已通过门禁的建议登记为待人工审批 Proposal。当前 Source 不包含审批、改价、调预算或其他商业写操作。

## Scope

- 店铺：`demo-shop`
- 币种：CNY，金额单位为分
- 时间窗口：`[start, end)`
- 数据源：固定 Fixture，仅用于可复现开发与评测

## Guidelines

1. 每次查询必须提供 `run_id`、`case_id`、SKU 和带时区的时间窗口。
2. 使用 `query_sales`、`query_inventory`、`query_promotions`、`compute_margin`、`query_ads` 获取经营证据。
3. 使用 `get_evidence` 按原店铺和 SKU 范围复核证据。
4. 用 `validate_report` 完成证据、数值、口径和持久化门禁；只有返回可读取的 `report_id` 才算完成。
5. 仅对 `RESOLVED` 报告使用 `create_proposal`，再用 `get_proposal` 查看状态。批准、拒绝与执行由独立人工 CLI 完成。
6. 缺失结果不能替换为有效零值；多币种不得直接合并。
7. 工具返回的是事实和确定性指标，不代表已经证明现实因果。

## Read-only guarantee

本 Source 注册查询、计算、报告校验和提案记录工具。批准、拒绝、执行和真实平台写入不在模型工具集中。
