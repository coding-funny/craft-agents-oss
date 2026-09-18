# SLO 与试运行验收

这些是首轮待校准目标，不是已测结果：只读 API P95 ≤ 500ms、错误率 < 1%；Worker 心跳 60 秒内；RPO ≤ 24 小时、RTO ≤ 30 分钟；UNKNOWN 必须在 deadline 前转 APPLIED/FAILED/MANUAL_REVIEW。

工程发布至少需要：全量测试、WebUI build、镜像 digest、Schema 版本、fixture/fake 演练和 SQLite 隔离恢复校验。Pilot 额外要求 PostgreSQL 运行时接入及真库验证、live 模型冻结集与人工复核、关键浏览器 E2E、实际备份恢复、24 小时 soak。所有结果写入 release manifest，缺项是 BLOCKED，不按 skipped 通过。

当前边界：API/Worker 运行时仍使用 SQLite；PostgreSQL 只有 Schema、迁移与 Repository 层，故 pilot preflight 固定阻断 PostgreSQL 配置。OpenTelemetry exporter、外部告警路由、可部署 Worker 进程、企业 IdP、真实平台凭证、真实模型预算和试运行使用者均未完成或未提供。当前只能标记 `CODE_READY`，不能标记 `PILOT_VERIFIED` 或“已生产上线”。

受控试运行从 shadow/read-only 开始，记录授权主体、数据范围、模型/Prompt/Tool/Policy 版本、任务数、反馈、费用、故障和恢复。扩大写操作需平台适配、授权及审批链路单独通过。
