# 生产化升级执行记录

## 当前状态

更新时间：2026-09-18。

01 链路已完成 B00—B07 编码和离线验收；02、03 链路已完成本地代码与离线验收。未运行真实模型，未接入真实商家数据，未执行真实 PostgreSQL 迁移、外部企业 IdP 或部署验收。

当前工作目录：`/Users/chenglin.zhou/Projects/Demo/agent/craft-agents-oss`。执行分支 `codex/production-upgrade-04`，父实现 commit=`d8a64666`；用户暂存的 `packages/core/src/types/index.ts` 修改保持不动且不纳入提交。

| 链路 | 状态 | 当前批次 | 代码/验收证据 | 下一步 |
| --- | --- | --- | --- | --- |
| 01 真实模型与动态调查 | CODE_READY / B08 BLOCKED_EXTERNAL | B00—B07 完成 | 32 项 agent 测试；真实 stdio MCP 纵向链路；20 条 dev | 提供明确 live 模型配置与预算后执行 5 条 smoke |
| 02 数据接入与证据治理 | CODE_READY / 外部验收阻塞 | B00—B07 本地完成 | 124 项全回归；多格式导入、不可变 snapshot、真实 stdio imported MCP | 提供 PostgreSQL URL 与授权数据后补 B07/B08 |
| 03 身份授权与审批治理 | CODE_READY / 外部验收阻塞 | B00—B06 本地完成 | 141 项全回归；真实本地 OIDC HTTP；RBAC/API/审批/撤销/RLS 合同 | 提供 PostgreSQL 应用角色与外部 IdP 后补 B07 |
| 04 持久任务与可靠执行 | CODE_READY / 外部验收待执行 | B00—B07 本地完成 | 156 项全回归；多进程租约、独立 HTTP 平台、UNKNOWN 对账 | 真 PostgreSQL 和授权平台验收 |
| 05 真实评测与回归门禁 | PLANNED | 无 | 无 | 种子工作随 01 开始 |
| 06 运营交互与业务反馈 | PLANNED | 无 | 无 | 等待 API 与任务契约 |
| 07 部署运维与试运行验收 | PLANNED | 无 | 无 | 环境基础随 02 建立 |

状态定义见 [入口](./README.md)。依赖的代码契约稳定而外部验证未完成时，记录具体依赖，不把整个项目简单标记为已完成或全部阻塞。

## 规划决策记录

| 日期 | 决策 | 原因 | 影响 |
| --- | --- | --- | --- |
| 2026-09-18 | 新建 production-upgrade，保留原五条链路 | 区分原型历史与下一轮生产化目标 | 原计划不覆盖、不重新计数 |
| 2026-09-18 | 01 建评测种子，05 做完整评测 | 及时验证真实模型价值 | 评测不延迟到功能全部完成 |
| 2026-09-18 | PostgreSQL Repository 在 02 落地 | 03/04 共用租户和事务边界 | 04 聚焦调度与外部一致性 |
| 2026-09-18 | 首轮真实数据入口为授权导出，远端动作先接独立测试平台 | 可复现且不依赖未获授权的广告接口 | 生产平台写入另设外部条件 |
| 2026-09-18 | 以模块化单体和分离 Worker 起步 | 保留工程深度并控制运行复杂度 | 不预置多 Agent、K8s、向量库 |
| 2026-09-18 | 以用户指定的新目录重新核验源码 | 新目录只有规划与通用宿主，缺 commerce 包/scripts | 新增 01/B00；旧测试数字不沿用 |
| 2026-09-18 | 01 固定为单次模型生成端口 + 自有受限 Loop | 通用 AgentBackend 包含自己的循环和编码工具；难以直接精确控制每次请求 | 复用 pi-ai 底层能力，不全局修改 coding Agent 权限 |
| 2026-09-18 | 01 展开为九批次和42项断言 | 细化输入/输出、接口、状态、文件及完成条件 | 仍为规划，未执行任何编码批次 |
| 2026-09-18 | 01 使用受限单次模型驱动与宿主 Loop | 全量 coding Agent 不适合作为 commerce 工具安全边界 | live/fake 明确分离；无自动降级 |
| 2026-09-18 | MCP stdio 增加 `inheritEnv:false` | 黑名单无法证明 provider 凭据不进入子进程 | commerce 子进程使用显式环境白名单 |
| 2026-09-18 | 澄清继续使用 task version + parent Run | 防止旧答案覆盖新范围并保留跨进程审计 | stale version 拒绝；预算从父 manifest 继承 |
| 2026-09-18 | 02 保持 01 CommerceAdapter，新增 snapshot-bound 实现 | 避免重写调查 Loop，并固定单次 Run 的数据版本 | fixture/imported 通过同一 MCP 工具契约 |
| 2026-09-18 | 数据记录按 tenant/shop/kind/source/sourceRecordId 版本化 | 同 ID 修订不能重复记账，不同来源不能误去重 | snapshot 保留不可变 membership 和逐记录来源 |
| 2026-09-18 | PostgreSQL 验证与 SQLite 合同分层 | 当前无真库/容器，不能让本地测试冒充生产数据库 | URL 缺失时 postgres 测试明确 exit 1 |
| 2026-09-18 | 03 采用独立 Commerce API + OIDC PKCE opaque session | 宿主 token 不能证明 commerce tenant/shop/role；独立边界更易验权 | 06 可挂载 handler，但不能绕过 membership、CSRF 或 scope |
| 2026-09-18 | Proposal v2 与审批/执行主体分离 | 防自审、参数换绑、任意 actor 和审批后撤权失效 | 执行仅接受 service identity，并可重查原审批人权限 |

## 待落实的外部条件

| 条件 | 首次需要位置 | 缺失时可继续 | 不能宣称完成的内容 |
| --- | --- | --- | --- |
| 可用模型配置及运行预算 | 01 真模型 smoke、05 批量评测 | 驱动、fake transport、契约、数据集、预算控制 | 真模型端到端验收与质量/成本数字 |
| 有权限使用的实际经营数据 | 02 实际导入验收、07 pilot | 导入器、生成数据、独立 HTTP 测试服务 | 已验证真实商家数据适配 |
| PostgreSQL / 容器运行环境 | 02 DB 集成测试 | Schema、迁移脚本、纯契约测试 | PostgreSQL 并发和持久化验收 |
| 试运行环境和使用者 | 07 | 部署包、本地 staging、备份恢复演练 | 已完成真实业务试运行 |

后续执行先检查项目明确配置，已有配置与授权可直接复用；需要新增选择时只询问阻塞部分。记录配置是否可用，不记录密钥值。

## 初版规划验证（旧工作区记录）

2026-09-18 完成 10 份 Markdown：总入口、共享契约、7 条链路、执行记录。

- 相对文档链接目标存在性检查通过。
- 代码围栏配对、行尾空白检查通过。
- 七条链路均包含输入、范围、文件位置、执行任务、验证、完成门槛和回退交接。
- 七条链路状态均为 PLANNED，所有实施复选框未勾选。
- 依赖复核：05 的种子工作在 01 开始；02 提供共用 PostgreSQL；06 依赖 03/04 契约；07 汇总发布门禁，无完整链路的循环前置。
- 本轮未修改业务代码、未重新运行既有业务测试，未执行 Git 提交。

## 01 详细规划记录（当前工作区）

- Plan：核验新目录与现有后端/MCP，细化01，不开始编码。
- 产物：01第8—14节新增固定决策、具体契约、状态/预算算法、B00—B08、T01—T42、命令/样例/20条种子及分层完成门槛。
- 配套同步：README和00标明commerce基线缺失，撤下不存在的本地文档链接；本执行记录区分历史与当前证据。
- Review：当前完整AgentBackend不能被直接等同于受限单次模型驱动；CraftMcpClient继承环境需在实施时增加显式allowlist；已写入B02/B03及对应断言。
- 外部/前置条件：基线来源与补齐方式在B00核验，模型配置/预算在B02和B08检查；本轮未迁移代码或读取密钥。
- Git：仅修改规划文档，未暂存或提交，用户已有暂存修改保留。当前 `.git/info/exclude` 第7行忽略 `tutorials/`；文档已写入磁盘但不会出现在普通 git status，本轮不修改排除规则或强制暂存。
- Verify：10份文档链接、代码围栏、行尾空白检查通过；01的JSON示例可解析，B00—B08九批次均包含输入/输出/文件/断言/完成条件，T01—T42编号连续完整。业务与付费模型测试未运行。

## 01 实施记录（当前工作区）

- 状态：CODE_READY；B08 为 BLOCKED_EXTERNAL。
- B00：从本地历史基线 `0561730` 恢复 `packages/commerce-agent/`、`examples/commerce-workspace/` 与 root scripts；恢复后基线 75 tests / MCP 集合 49 tests 均通过。
- B01—B05：实现严格任务输入、可信 principal/shop scope、状态机、task/run/event/checkpoint SQLite 存储、预算/上下文/循环检测、单次 pi-ai driver、scripted fake、九工具白名单 dispatcher、报告修复及 REPORT_READY 回读门禁。
- B06：实现 investigate/status CLI、稳定退出码、task version、stale answer 拒绝、跨进程 parent Run 与父 manifest 预算继承。
- B07：建立 20 条 dev、独立 gold、5 条 smoke split 和 deterministic grader；命令只声明 dataset_ready，不伪造模型准确率。
- Verify：`commerce:typecheck`、`typecheck:shared` 退出 0；最终 `commerce:test` 为 107 passed / 0 failed / 334 assertions；5 条 smoke 开发集加载通过。
- Review：真实 stdio 纵向测试通过；曾发现 `approved` 被措辞正则误判为 `prove`，已通过英文单词边界修正并回归。模型/数据模式和 fake/live 证据严格分开。
- 外部阻塞：未提供显式 provider/model/api-key env 和总预算，T40—T41 未运行；不读取或搜索机器上的无关密钥。
- 交接：`packages/commerce-agent/docs/implementation/01/{baseline-audit,backend-decision,acceptance,handoff}.md`。
- Git：本批次以 `feat(commerce): add production investigation runtime` 提交；用户已有 `packages/core/src/types/index.ts` 暂存修改不纳入。

## 02 实施记录（当前工作区）

- 状态：CODE_READY；PostgreSQL 真库和授权数据 B07/B08 为 BLOCKED_EXTERNAL。
- Plan：02 第 8—14 节补充实际 01 契约、输入输出、状态机、表结构、文件清单、B00—B08、T01—T25 和三级完成条件后再编码。
- Execute：实现严格 ImportManifest、JSON/JSONL/CSV 解析、路径/摘要/授权声明校验、quarantine、来源内幂等和修订、SQLite/PostgreSQL 异步 Repository、不可变 snapshot、ImportedDataAdapter、evidence v2、freshness/claim review、HTTP 分页故障语义、import/migrate CLI 及 imported stdio MCP 模式。
- Verify：Bun 1.4.2；`commerce:typecheck` exit 0；最终 `commerce:test` 124 passed / 0 failed / 402 assertions。dry-run accepted=8 且零写入；apply accepted=8 并生成 snapshot。HTTP localhost 测试在获得监听权限后通过，未改成 skip。
- PostgreSQL：migration runner、SQL 和 repository 已实现；当前无 docker/podman/psql 或 `COMMERCE_TEST_DATABASE_URL`。专用命令 exit 1 并明确未执行，不能标 POSTGRES_VERIFIED。
- Data：提交样例标记为 SYNTHETIC_FIXTURE；没有授权经营数据，不标 REAL_DATA_VERIFIED。没有运行 live model。
- Review：修正了初版去重键遗漏 sourceId 的问题；最终记录身份为 tenant/shop/kind/source/sourceRecordId。报告硬门禁拒绝混用 legacy/governed 或跨 snapshot/口径证据；semantic reviewer 不可用时只返回 PENDING_REVIEW。
- Handoff：`packages/commerce-agent/docs/implementation/02/{baseline-audit,storage-decision,data-dictionary,acceptance,handoff}.md`。03 基于现有 scope 做身份/RBAC/RLS 和审批仓库迁移。
- Git：以 `feat(commerce): add governed data ingestion` 独立提交 02 文件；提交后工作树仅保留用户原先暂存的 `packages/core/src/types/index.ts`。

## 03 实施记录（当前工作区）

- 状态：CODE_READY；真实 PostgreSQL RLS/连接池和外部企业 IdP B07 为 BLOCKED_EXTERNAL。
- Plan：在 01/02 可信 scope 与 snapshot 基础上实现身份、会话、业务 API、Proposal v2、审批策略和执行前撤权重验，不把宿主 token 或请求 actor 当业务授权。
- Execute：实现 OIDC Authorization Code + PKCE/JWKS、opaque session、membership/shop grants/RBAC、Cookie/CSRF/CORS；新增独立 `/api/v1` handler、task 幂等与 scoped 读取；审批绑定 proposalHash/policy/snapshot/targetVersion 并禁止自审；执行要求 service identity，可重查原审批人；旧 CLI 仅在显式 local-test 模式可用。
- PostgreSQL：新增 `0002_identity_authorization_rls.sql`、FORCE RLS policy 和 transaction-local `set_config` helper。当前没有应用角色测试库，不能标 RLS_VERIFIED。
- Verify：Bun 1.4.2；`commerce:typecheck` exit 0；完整 `commerce:test` 为 141 passed / 0 failed / 449 assertions。本地签名 IdP 通过真实 loopback HTTP authorize/token/JWKS，state replay 被拒绝。
- Review：跨 tenant 对象统一 404；同 tenant 未授权 shop 拒绝；Idempotency-Key 同 payload replay、异 payload 409；approve/reject 竞态仅一个终态；审批人撤销后执行 fail-closed。未将本地 IdP 称为企业 SSO。
- Handoff：`packages/commerce-agent/docs/implementation/03/{identity-adr,permissions,api,acceptance,handoff}.md`。04 应复用 service principal 与 approvalGuard，不恢复任意 actor 字符串。
- Git：以 `feat(commerce): add identity and approval governance` 独立提交 03 文件；用户已有 `packages/core/src/types/index.ts` 暂存修改保持不动且不纳入。

## 04 实施记录（当前工作区）

- 状态：CODE_READY；真 PostgreSQL 与授权远端平台为 BLOCKED_EXTERNAL。
- Plan：在 01 task/run/checkpoint 与 03 service identity/approvalGuard 基础上，增加持久 job、lease epoch fencing、outbox、发送前记账、远端幂等/版本条件和 UNKNOWN 有界对账。
- Execute：实现 DurableJobRepository/Worker/handlers，租户并发上限、心跳、取消、过期接管、checkpoint、MANUAL_REVIEW；task/审批与 job/outbox 同事务；ActionExecutor/HTTP adapter/ReliableExecutionService 实现 PREPARED→SENT→UNKNOWN/APPLIED 协议。
- PostgreSQL：新增 `0003_durable_jobs_execution.sql`，含 RLS/FORCE RLS、tenant policy、索引与 `FOR UPDATE SKIP LOCKED` claim function。当前无真库，只通过静态契约检查。
- Verify：Bun 1.4.2；`commerce:typecheck` exit 0；`commerce:test:runtime` 8 pass；`commerce:test:execution-http` 7 pass；完整 `commerce:test` 156 pass / 0 fail / 516 assertions。
- Review：两个独立 Bun 进程竞争 20 jobs 无重复 checkpoint；平台已应用但返回 503 时本地进 UNKNOWN，lookup 恢复 APPLIED，POST/effect 均为 1；非权威 NOT_FOUND 不盲重发；无幂等且无 lookup 转人工。
- Handoff：`packages/commerce-agent/docs/implementation/04/{runtime-adr,execution-boundaries,acceptance,handoff}.md`。05 消费故障统计；06 展示等待/取消/UNKNOWN/人工队列；07 执行真 PostgreSQL 并发与运维验收。
- Git：以 `feat(commerce): add durable jobs and reliable execution` 独立提交 04 文件；用户已有 `packages/core/src/types/index.ts` 暂存修改保持不动且不纳入。

## 执行批次模板

复制本节为新批次，实际执行前填写 Plan，执行后填写结果。模板中的占位内容不是证据。

### 批次：链路 NN / 任务范围 / 日期

- 状态：IN_PROGRESS / CODE_READY / VERIFIED / BLOCKED_EXTERNAL。
- 输入基线：分支、commit、相关已有修改、上一批次产物。
- Plan：本轮完成哪些任务；业务完成条件；依赖；拟修改文件；需要验证的假设。
- Execute：实际改动、采用/放弃的设计与理由。
- Verify：命令、环境、退出码、测试/样本数、原始结果位置；真实与模拟明确分开。
- Review：失败路径、身份与数据边界、未解决问题及严重性。
- Replan：偏差原因、受影响文档/契约、兼容/迁移方案；无偏差写无。
- Git：实际 diff 范围；如已获授权提交，记录 commit；未提交写未提交。
- Handoff：稳定接口、配置、启动命令、下一任务、外部阻塞及独立可继续事项。

## 验收索引模板

后续每条链路在自身计划末尾记录完成证据，并在这里建立索引。原始执行产物建议存入 `packages/commerce-agent/artifacts/production-upgrade/<chain>/<run-id>/`，该目录为拟新增。

每份 manifest 记录 commit、环境、模式、输入版本、开始/结束时间、检查项、退出码和产物摘要。原始含业务数据的文件默认不进入 Git；可提交脱敏样例、结果摘要和复现命令。避免绝对本机路径、密钥或完整客户订单进入提交。
