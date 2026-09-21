# 10 分钟 Demo 脚本

## 0—2 分钟：范围和架构

说明数据是固定 Fixture、执行是 Mock；展示 MCP/Skill、Evidence Gate、Proposal/审批、Execution/Recovery 四层。强调模型没有批准和执行工具。

## 2—4 分钟：Source 与 MCP

运行：

```bash
bun run commerce:demo
```

命令会幂等安装演示 Source，启动真实 stdio MCP，列出 9 个工具，并调用 `query_sales` 验证净销售额和 Trace。

## 4—6 分钟：诊断与报告

展示 `report_id` 及对应 JSON/Markdown。解释广告案例中 CPC 40→50 分、CVR 4%→1.6%、ROAS 5→1.6；这些数值由 Evidence 重算，而不是相信模型文本。

## 6—8 分钟：审批与执行

展示 Proposal 的内容哈希、过期时间和幂等键。Demo Runner 使用模型外的 `demo-operator` 身份审批，随后把 Mock `CAMPAIGN-C` 预算从 50000 调整为 30000，版本从 1 增至 2。

## 8—9 分钟：幂等与恢复

Runner 立即重复执行，`operation_count` 保持 1。再次运行整条 `commerce:demo`，Report/Proposal 不变，只有恢复 Trace 增加并指向父 Trace。

## 9—10 分钟：评测与失败路径

```bash
bun run commerce:eval
bun run commerce:eval:failures
```

展示 24 条确定性回归和 11 类故障注入，同时主动说明：没有外部 LLM 评测、没有真实平台写入、没有生产收益数据。
