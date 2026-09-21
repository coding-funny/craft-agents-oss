# 链路 2：MCP 与宿主接入

## AI 任务

把链路 1 的纯领域能力封装成独立电商 MCP Server，并通过现有 Craft Agents 的 Source、Setup、权限和会话工具体系接入宿主；同时建立统一超时、限流重试、结果截断与 Trace 传播。

## 必读输入

- [链路 1：基础数据与计算](./01-基础数据与计算链路.md)
- `tutorials/02-电商数据工具与审批契约.md`
- `packages/session-mcp-server/src/index.ts`
- `packages/shared/src/mcp/client.ts`
- 仓库中 Source builder、Setup、permissions 相关实现与测试
- `packages/commerce-agent/demo/progress.md`

## 进入条件

- 链路 1 的 typecheck 与 test 全部通过；
- Fixture Adapter、指标服务和 Evidence Repository 已有稳定接口；
- 领域代码不依赖 Electron。

## 允许改动范围

- `packages/commerce-agent/**`
- 新建电商 Source/Setup 目录及其最小注册代码
- 为该 Source 增加必要的图标、模板和测试
- 仅在有测试证明现有扩展点不足时，最小修改共享接入代码

## 目标文件

```text
packages/commerce-agent/src/
├── mcp/
│   ├── server.ts
│   ├── schemas.ts
│   ├── tool-runner.ts
│   └── trace.ts
├── tools/
│   ├── query-sales.ts
│   ├── query-inventory.ts
│   ├── query-promotions.ts
│   ├── query-ads.ts
│   └── get-evidence.ts
└── setup/
    ├── source-template.ts
    └── setup-check.ts
```

Source 文件遵循仓库现有位置和格式，不另造平行规范。

## 实现步骤

### E05：实现电商 MCP Server

1. 使用现有 MCP SDK 和仓库约定启动独立 Server。
2. 首批工具：

   - `commerce.query_sales`
   - `commerce.query_inventory`
   - `commerce.query_promotions`
   - `commerce.query_ads`
   - `commerce.get_evidence`

3. 输入输出由 schema 严格校验，禁止接收任意 SQL 或任意文件路径。
4. 工具返回统一 `ToolEnvelope<T>`，失败时返回稳定错误码。
5. 写 MCP 级集成测试：启动 Server，通过 Client 调工具，验证完整 envelope。

### E06：实现 Tool Runner 与可观测性

Runner 必须统一处理：

- 每次调用生成或继承 `trace_id`；
- 记录 `tool_call_id`、工具名、参数摘要、耗时、状态和证据 ID；
- 每个工具设置明确超时；
- 仅对 `RATE_LIMITED` 和部分瞬态超时重试；
- 使用指数退避、抖动和总重试预算；
- 永久错误、校验错误不重试；
- 大结果按稳定策略截断并保留证据引用；
- 日志脱敏，不输出 token、密钥或完整敏感记录。

至少覆盖：

- 第一次限流、第二次成功；
- 持续限流直至预算耗尽；
- 永久错误零重试；
- 超时取消；
- 超大结果截断；
- 子调用继承同一 Trace。

### E07：接入 Source、Setup 与权限模型

1. 用现有 Source builder 生成电商 Source。
2. Source 中配置：

   - MCP 启动命令；
   - 固定数据或 Mock 数据目录；
   - Skill 安装位置；
   - 允许使用的工具；
   - 必要环境变量模板。

3. Setup 支持：

   - `dry-run`：只输出将创建或修改的内容；
   - `apply`：幂等写入；
   - 重复执行不产生重复 Source；
   - 缺文件、端口冲突、环境变量缺失时给出可操作错误。

4. 权限默认只读。后续审批与模拟执行工具不得在本链路提前暴露。
5. 通过真实宿主创建会话，证明模型能发现并调用电商工具。

## 强制测试

- 每个 MCP 工具的 schema 正反例；
- MCP Client 到 Server 的进程级集成测试；
- 工具超时、限流、重试预算和截断；
- Trace 从会话调用传播至 Evidence；
- Setup dry-run、apply、重复 apply；
- Source 被宿主识别，权限只包含只读工具；
- MCP 断开时宿主得到结构化错误，不崩溃。

## 验收命令

具体脚本名可按仓库约定实现，但必须提供等价的一键命令：

```bash
bun run commerce:typecheck
bun run commerce:test
bun run commerce:test:mcp
bun run commerce:setup --dry-run
bun run commerce:setup
```

## 完成门槛

- 五个只读工具能通过 MCP Client 稳定调用；
- Tool Runner 的超时、重试、Trace 和日志可被测试证明；
- Source/Setup 可重复安装且不产生重复配置；
- 宿主真实会话能发现至少一个电商工具并返回证据引用；
- 默认权限中没有审批或执行能力；
- 进度文档已记录安装方式、启动方式、测试结果和遗留风险。

## 禁止事项

- 不修改通用 Prompt 来硬编码电商行为；
- 不把数据逻辑复制进 MCP handler；
- 不对参数错误进行重试；
- 不在日志中输出密钥；
- 不开放真实业务写权限；
- 不以“Server 能启动”代替宿主真实接入验证。

## 交给下一链路的产物

- 可由宿主发现的电商 Source；
- 五个只读 MCP 工具；
- 统一 Tool Runner 和 Trace；
- 可重复执行的 Setup；
- 一段真实宿主工具调用 Trace 及其 Evidence ID。
