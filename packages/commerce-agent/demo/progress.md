# Commerce Agent 实施进度

## 链路 1：基础数据与计算

状态：已完成并通过验收。

### 已实现

- 独立 workspace 包与根级 typecheck/test 脚本；
- 领域契约、统一错误模型和单币种安全整数金额约束；
- 固定 Fixture Adapter，使用 `[start, end)` 时间窗口；
- 稳定证据 ID、证据详情读取与 Trace 引用；
- 销售、库存、促销、广告和贡献毛利确定性指标；
- 库存断货、促销毛利下降、广告转化下降三类固定案例；
- 边界、退款、取消单、零销量、重复数据、多币种和证据稳定性测试。

### 验收结果

```bash
bun run commerce:typecheck
# 通过：TypeScript 0 errors

bun run commerce:test
# 通过：21 pass, 0 fail, 66 expect() calls

bun test packages/commerce-agent/tests --coverage
# 通过：94.76% functions, 99.13% lines
```

验收环境：Bun 1.4.2，2026-09-17。

### 当前限制

- Fixture v1 仅允许 `demo-shop` 和 CNY；
- 潜在缺货损失是基于零库存快照日与窗口日均净销售额的演示估算，不是因果归因；
- 贡献毛利口径不包含广告摊销，广告指标独立输出；
- 链路 1 本身不包含 MCP、Skill、报告或审批；MCP 已在链路 2 实现，其余能力继续后续链路。

## 链路 2：MCP 与宿主接入

状态：编码与本地宿主接入验收已完成。

### 已实现

- 独立 stdio MCP Server，仅注册 `query_sales`、`query_inventory`、`query_promotions`、`query_ads`、`get_evidence`；
- Zod 严格入参校验，拒绝任意 SQL、文件路径、未知字段和越界店铺；
- Tool Runner 统一处理 Trace、超时、瞬态错误重试预算、指数退避、稳定截断和错误码；
- Trace 参数摘要脱敏，不记录 token、密钥或完整超长数据；
- Source 配置、guide 和只读 permissions 模板；
- Setup CLI 支持 `dry-run`、幂等 `apply` 和冲突拒绝覆盖；
- 使用现有 `loadSource`、`SourceServerBuilder` 和 `CraftMcpClient` 完成真实 stdio 宿主接入测试；
- MCP 断连返回可捕获错误，不导致测试宿主崩溃。

### 安装方式

```bash
bun run commerce:setup --workspace /ABSOLUTE/CRAFT/WORKSPACE --dry-run
bun run commerce:setup --workspace /ABSOLUTE/CRAFT/WORKSPACE --apply
```

安装后的宿主工具名为：

```text
mcp__commerce__query_sales
mcp__commerce__query_inventory
mcp__commerce__query_promotions
mcp__commerce__query_ads
mcp__commerce__get_evidence
```

### 验收结果

```bash
bun run commerce:typecheck
# 通过：TypeScript 0 errors

bun run commerce:test
# 通过：37 pass, 0 fail, 121 expect() calls

bun run commerce:test:mcp
# 通过：16 pass, 0 fail, 55 expect() calls
```

Setup CLI 验收结果：第一次 dry-run 报告 3 个待创建文件；第一次 apply 创建 3 个文件；第二次 apply 全部返回 `unchanged`。

宿主调用证据：

```text
trace_id: trace-acceptance-001
evidence_id: ev_7b0464237e3fbed640606b8d
net_sales_minor: 110000
```

### 当前限制

- 当前仅支持 `readonly` 模式和固定 `demo-shop` Fixture；
- Evidence Repository 仍是进程内存实现，MCP 进程重启后的持久化属于后续 Case/Storage 链路；
- Setup 不会覆盖已有同名 Source 文件，冲突需要人工处理；
- 已完成真实宿主 Source/stdio/Client 路径验证，但未消耗模型额度运行真实 LLM 会话；模型按 Skill 自主编排多工具属于链路 3；
- 尚无审批、拒绝、执行或真实平台写工具。

## 链路 3：诊断与报告

状态：收尾验收完成。

### 已实现

- 工作区级 `commerce-diagnosis` Skill 使用 `requiredSources: [commerce]` 绑定 Source，并限制模型可见的诊断/提案工具；
- 诊断路由由观测指标决定，不读取 Case 名称决定分支；销量、库存、促销、贡献毛利和广告数据按固定预算联合调查；
- 硬性工具调用预算在查询前检查，超限时不发起部分调用；
- 严格报告 Schema 分离 FACT、HYPOTHESIS、UNKNOWN、RECOMMENDATION，并为建议加入稳定 ID 和结构化 `actionDraft`；
- 报告门禁从原始 Evidence 重算净销售额、缺货 SKU 数、贡献率、广告花费、CTR、CVR、CPC、ROAS，拒绝模型伪造 KPI 值或调换基线/当前期证据；
- Evidence 与 Report 同时持久化到 SQLite，进程重启后仍可按 ID 读取；Report 回读时重新计算内容哈希和 `report_id`，拒绝落库后篡改；
- JSON/Markdown Artifact 继续原子写入文件，供演示和人工审阅；
- 真实宿主的 Source、stdio、`CraftMcpClient` 路径已覆盖查询、报告校验、`create_proposal` 与 `get_proposal`。

### 三类固定报告

| Case | Status | Report ID | Trace ID |
| --- | --- | --- | --- |
| inventory-shortage | NEEDS_DATA | `report_bc76dfece6cb45371907ac73` | `trace-inventory-shortage-001` |
| promotion-margin | NEEDS_DATA | `report_fbb98208ba0fe627a940558f` | `trace-promotion-margin-001` |
| ads-conversion | RESOLVED | `report_20d555564f9f5ab3528baef5` | `trace-ads-conversion-001` |

前两类报告因缺少对应 SKU 的广告归因记录保留 `NEEDS_DATA`；广告案例基线/当前 CPC 为 40/50 分，CVR 为 4%/1.6%，ROAS 为 5/1.6%。

### 收尾验收结论

- 篡改 KPI 值：拒绝；
- 调换基线/当前 Evidence：拒绝；
- 篡改已持久化 Report JSON：拒绝；
- 重启 Repository 后读取 Evidence/Report：通过；
- 通过 Case 名称诱导诊断分支：无效，分支由指标决定；
- 超过工具调用预算：查询前失败；
- MCP 宿主创建并回读 Proposal：通过。

### 边界

- 规则引擎输出可解释的关联假设，不声称证明业务因果；
- 已完成真实宿主和 MCP 进程级验收，但没有配置外部模型凭证运行一次付费 LLM 自主会话；该项属于部署环境验收，不影响确定性代码链路，后续可纳入 Eval 链路；
- 当前数据仍是单店铺、单币种 Fixture，不代表生产平台接入。

## 链路 4：审批与模拟执行

状态：全部完成并通过验收。

### 已实现

- SQLite 持久化 Proposal、Approval、Execution Attempt、Audit Event、Mock Platform State 与外部操作台账；
- Proposal 从 `RESOLVED` Report 的结构化建议生成，绑定 Report、Trace、Evidence、动作、参数、风险、过期时间、内容哈希与幂等键；
- 状态机覆盖 `DRAFT -> PENDING_APPROVAL -> APPROVED/REJECTED/EXPIRED -> EXECUTING -> SUCCEEDED/FAILED/UNKNOWN`，迁移采用事务与条件更新；
- 模型只能调用 `create_proposal` 和 `get_proposal`，不能调用 approve、reject、execute 或 reconcile；
- 独立人工 CLI 在批准时要求输入与展示内容一致的 `--confirm-hash`，审批记录绑定 actor、reason 和内容哈希；
- Mock Executor 支持调整广告预算、暂停广告活动、创建补货任务和促销工单，且与分析 Fixture 分库存储；
- 执行前复核审批、有效期和内容哈希；未审批、拒绝、过期、被篡改的 Proposal 均无法产生副作用；
- 幂等键和外部操作台账具有唯一约束；并发执行和重复执行只产生一次副作用；
- 响应丢失进入 `UNKNOWN`，不会自动重写；`reconcile` 根据外部操作台账恢复为 `SUCCEEDED` 或确认 `FAILED`；
- 审计事件记录 Proposal、Trace、actor、前后状态、失败原因和外部操作 ID。

### 人工验收案例

| 路径 | Proposal | 结果 |
| --- | --- | --- |
| 批准并执行 | `proposal_1bcbf4d34e6323a2371bade8` | `CAMPAIGN-C` 预算由 50000 降至 30000、版本 1 升至 2；第二次执行返回首次结果，只有一个 Mock Operation |
| 人工拒绝 | `proposal_ad2c9ce79e3f19f379801143` | 状态变为 `REJECTED`，未执行任何写动作 |
| 响应丢失与核对 | `proposal_e03c24e393c2e2cc2677ff48` | 首次写入后进入 `UNKNOWN`；未重试副作用；通过 `mockop_6b96b4fcd37ea35fe05392c3` 对账恢复 `SUCCEEDED` |

### 验收结果

```bash
bun run commerce:typecheck
# 通过：TypeScript 0 errors

bun run commerce:test
# 通过：66 pass, 0 fail, 203 expect() calls

bun run commerce:test:mcp
# 通过：40 pass, 0 fail, 125 expect() calls
```

自动化测试覆盖非法状态迁移、非 RESOLVED 报告、未审批/拒绝/过期/篡改、并发争抢、幂等重放、UNKNOWN 双向核对、持久化重启、报告哈希篡改、工具权限边界和真实 MCP 宿主调用。

验收环境：Bun 1.4.2，2026-09-17。

### 当前限制

- 所有写操作只作用于本地 Mock 平台，未连接任何真实电商平台；
- `reconcile` 依据 Mock 外部操作台账判断结果，生产接入时需替换为平台查询接口、告警和人工处置策略；
- 当前没有自动补偿或失败重试；任何补偿都必须创建新的 Proposal 并重新审批；
- 尚未实现多租户、密钥托管、RBAC 和生产级可观测性，这些不属于本阶段的本地 MVP 范围。

## 链路 5：恢复、评测与交付

状态：离线工程实现与验收完成；外部 LLM 回放未执行，不计入已完成指标。

### 已实现

- `case_runs` / `case_events` 持久化 session、状态、Report/Proposal ID、恢复次数和父子 Trace；
- Recoverable Runner 以报告持久化、Proposal 等待审批、执行终态、UNKNOWN 或超时作为完成信号；
- 报告后中断可从原 `report_id` 继续，成功执行后重复恢复不创建新 Proposal 或副作用；
- UNKNOWN 恢复只做外部操作台账对账，不自动重复写入；
- 真实 stdio MCP 客户端关闭后重连，可以读取同一 SQLite 中的 Proposal；
- 24 条确定性回归数据集，按 16 条 dev / 8 条 holdout 分离；
- 两组确定性反事实基线及六项消融；Retry Budget 消融实际运行“首次限流、第二次成功”和“禁用重试立即失败”两条路径；
- 11 类故障注入：超时、429、非法 Schema、数据源缺失、Evidence 冲突、持久化失败、审批过期、Proposal 篡改、双进程并发执行、响应丢失和会话恢复；
- 一键 Demo 幂等安装 Source、启动真实 stdio MCP、运行诊断、生成 Proposal、模型外审批、Mock 执行和恢复重放；
- 架构、决策、评测、Demo、面试问答和简历证据映射文档。

### 确定性评测

```text
dataset: 24（dev 16 / holdout 8）
result: 24 pass / 0 fail
unsupported claim rate: 0/7
failure injection: 11 pass / 0 fail
```

这里的 24 条是固定 Fixture 上的 synthetic regression cases，不是 24 个真实商家事故，也不是 24 次外部 LLM 推理。完整分母和原始结果位于 `demo/results/`。

### 一键 Demo 验收

连续运行两次：

```bash
bun run commerce:demo
bun run commerce:demo
```

两次均得到：

```text
session_id: session-commerce-demo-ads
report_id: report_20d555564f9f5ab3528baef5
proposal_id: proposal_31a4c24d9cfc8139a6590739
status: SUCCEEDED
mcp_tools: 9
operation_count: 1
replayed: true
```

第二次运行生成新的恢复 Trace 并指向前一次 Trace，但复用相同 Report、Proposal 和 Mock Operation。

### 验收结果

```bash
bun run commerce:typecheck
# 通过：TypeScript 0 errors

bun run commerce:test
# 通过：75 pass, 0 fail, 240 expect() calls

bun run commerce:test:mcp
# 通过：49 pass, 0 fail, 162 expect() calls

bun run commerce:eval
# 通过：24 pass, 0 fail

bun run commerce:eval:failures
# 通过：11 pass, 0 fail

bun run commerce:demo
# 通过：SUCCEEDED，operation_count=1
```

验收环境：Bun 1.4.2，2026-09-18。

### 当前限制

- 尚未配置外部模型凭证运行单轮 Prompt 与 Agent 的真实模型对照，因此没有模型准确率、token 成本或随机性统计；
- 当前基线中标记为 counterfactual 的项目只用于隔离工程机制，不能写成模型质量提升；
- Case Recovery 是 SQLite 单机恢复，不等同于分布式工作流引擎；
- 数据、执行和指标仍来自 Fixture/Mock，不代表线上生产收益；
- 真实平台接入、多租户 RBAC、密钥托管、告警、补偿任务和长期观测仍未实现。
