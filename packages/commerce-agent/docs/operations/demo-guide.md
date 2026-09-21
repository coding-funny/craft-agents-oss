# 10 分钟发布演示

1. 用 1 分钟说明 API/UI、身份、队列 Worker、数据/证据和测试平台边界。
2. 运行 preflight，展示内联 secret、缺环境变量、pilot 未接 PostgreSQL runtime 会 fail-closed。
3. 打开 `/commerce` 完成异常→调查→报告证据→提案→审批；展示跨店铺拒绝。
4. 注入平台 503，展示 request 进入 UNKNOWN、lookup 对账恢复且副作用仅一次。
5. 展示 `/health/ready` 的 Worker 心跳失败、低基数 `/metrics` 和日志脱敏。
6. 执行非生产 SQLite backup verify，展示 integrity 与关键表 digest。
7. 用 pilot manifest 展示真实评测、E2E、PostgreSQL、恢复和 24h soak 缺一不可，最后明确当前证据边界。
