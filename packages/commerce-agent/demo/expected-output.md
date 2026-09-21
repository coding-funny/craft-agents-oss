# 一键 Demo 预期输出

```json
{
  "session_id": "session-commerce-demo-ads",
  "report_id": "report_20d555564f9f5ab3528baef5",
  "proposal_id": "proposal_<content-hash-prefix>",
  "trace_id": "trace-recovery-<attempt-hash>",
  "status": "SUCCEEDED",
  "mcp_tools": 9,
  "operation_count": 1,
  "replayed": true
}
```

首次运行和第二次运行的 `operation_count` 都必须为 1。恢复 Trace 可以变化，但第二次 Trace 必须通过 `parent_trace_id` 接到上一次尝试；Report 和 Proposal ID 保持稳定。
