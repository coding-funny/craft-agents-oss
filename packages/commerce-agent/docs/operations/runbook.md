# Commerce Agent 运维手册

## 发布顺序

1. 复制 `deploy/commerce/.env.sandbox.example` 到未纳入 Git 的 `.env.sandbox`，从 secret store 注入值。
2. 运行 `bun run commerce:preflight -- --config deploy/commerce/config/sandbox.json`；非 PASS 停止。
3. 运行 Commerce 全量测试、WebUI 构建和镜像构建，记录 commit 与镜像 digest。
4. 先迁移兼容 Schema，再启动 API/UI；检查 `/health/live`、`/health/ready` 和 `/metrics`。
5. 只读验证身份、tenant/shop 隔离、报告证据后再启动调查 Worker；执行 Worker 最后启动。

## 告警与处置

| 信号 | 初步处置 | 升级条件 |
| --- | --- | --- |
| readiness 失败 | 查看 database/schema/worker 子检查；不要因依赖故障循环重启 live 进程 | 连续 5 分钟 |
| Worker 心跳陈旧 | 停止分配，检查 lease；仅由 fencing token 接管 | 两个周期未恢复 |
| UNKNOWN 增长 | 暂停新执行，先 lookup 对账，禁止盲重发 | 超过 uncertainty deadline |
| 队列积压 | 区分模型限流、预算耗尽、数据库等待 | P95 等待超过既定 SLO |
| 备份失败 | 保留上次成功备份，修复后在隔离实例恢复校验 | 超过 24h RPO |

日志不得记录 token、Cookie、原始密钥或完整业务载荷。任务 ID 放日志/Trace，不作为指标 label。

## 回退

停止新任务和执行 Worker，记录在途 request/UNKNOWN；回退到与当前 Schema 兼容的镜像并检查身份、幂等台账和证据。数据库备份先恢复到隔离实例；任何覆盖操作需要单独授权。恢复执行前先对账远端动作。
