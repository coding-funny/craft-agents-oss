# Commerce Agent 架构说明

## 项目边界

这是一个面向电商经营诊断的本地可复现 Agent 工程原型。数据来自固定 Fixture，动作只写入 Mock Platform，不连接真实商家、广告或库存系统。

## 主链路

```text
Monitor / Detect
  Fixture Adapter -> MCP query tools -> Evidence Repository
                                      |
Investigate                           v
  Commerce Skill -> deterministic metrics -> diagnosis hypotheses
                                      |
Decide                                v
  validate_report -> JSON/Markdown Report -> immutable Proposal
                                      |
Act                                   v
  operator CLI approval -> Mock Executor -> audit/idempotency ledger
                                      |
Recover                               v
  Case Repository -> resume/reconcile -> terminal result
```

## 核心组件

- `FixtureAdapter`：限定店铺、SKU、币种和固定目录，输出原始记录及稳定 Evidence。
- `ToolRunner`：统一 Trace、超时、429 重试预算、参数摘要脱敏和结果截断。
- `commerce-diagnosis` Skill：规定调查顺序、工具白名单、事实/假设/建议边界。
- `validateAndPersistReport`：从 Evidence 重算 KPI，校验周期、作用域、单位和措辞，再持久化 Artifact。
- `ProposalService`：只允许 `RESOLVED` 报告生成不可变 Proposal。
- `ApprovalService`：模型外审批，审批记录绑定 actor、理由和 Proposal 内容哈希。
- `ExecutionService`：状态条件更新、唯一幂等键、UNKNOWN 状态和对账。
- `CaseRepository` / `runRecoverableCase`：持久化 session、父子 Trace、报告/提案 ID 和恢复事件。
- Eval Runner：执行 24 条确定性回归、基线/消融和 11 类故障注入。

## 信任边界

1. 模型输出不可信：所有参数先过 Zod，报告数值由服务端重算。
2. Proposal 创建不等于授权：模型没有 approve、reject、execute 或 reconcile 工具。
3. 人工审批也可能过期：执行前再次检查内容哈希、审批决定、有效期和目标版本。
4. 写入结果可能不确定：远端写成功但响应丢失时进入 `UNKNOWN`，禁止自动重写。
5. 文件与 SQLite 是本地原型边界，不代表多租户或生产级权限隔离。

## 持久化模型

SQLite 保存 Evidence、Report、Proposal、Approval、Execution Attempt、Audit Event、Mock Operation、Case Run 和 Case Event。报告文件同时输出 JSON/Markdown，便于人工审阅；SQLite 是恢复和一致性来源。

## 完成信号

Runner 只在以下状态返回：已校验报告、等待审批的 Proposal、`SUCCEEDED`、`FAILED`、`UNKNOWN` 或明确超时。消息已发送、首个 token 或工具开始调用均不算完成。
