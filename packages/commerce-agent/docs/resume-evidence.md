# 简历表述—工程证据映射

| 可陈述能力 | 代码证据 | 测试/运行证据 | 边界 |
| --- | --- | --- | --- |
| MCP/Tool Calling | `src/mcp/`、`src/tools/` | `mcp-integration.test.ts`，Demo 发现 9 个工具 | 固定 Fixture Source |
| Context Engineering | `src/setup/source-template.ts` 中 Skill/SOP | 三类诊断报告与工具预算测试 | 未做外部 LLM 质量评测 |
| Evidence-gated Report | `src/reports/validate-report.ts` | KPI/周期/篡改拒绝测试 | 相关性分析，不证明因果 |
| Human-in-the-loop Governance | `src/approvals/`、operator CLI | 未审批/拒绝/过期/篡改测试 | 本地 CLI，不是生产 RBAC |
| Idempotent Agent Runtime | `src/execution/` | 并发、重放、UNKNOWN 对账 | Mock Platform |
| Memory/Recovery | `src/recovery/`、`case_runs` | 中断续跑、父子 Trace、一次副作用 | SQLite 单机恢复 |
| Agent Eval | `evals/`、24 条 dataset | 24/24 deterministic，11/11 failures | 非 LLM、非生产数据 |

禁止写成：已上线、真实商家收益、模型准确率 100%、支持真实平台自动调预算或生产级多租户。
