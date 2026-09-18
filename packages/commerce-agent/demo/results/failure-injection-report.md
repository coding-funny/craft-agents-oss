# Commerce Agent 故障注入报告

> 所有故障均运行在固定 Fixture、临时 SQLite 和 Mock Executor 中，不连接真实平台。

| 故障 | 结果 | 预期保护行为 | 延迟 |
| --- | --- | --- | ---: |
| mcp-timeout | PASS | Return UPSTREAM_TIMEOUT without hanging. | 2.07ms |
| rate-limit-retry | PASS | Retry once within budget and return one successful result. | 0.84ms |
| invalid-schema | PASS | Reject before invoking a data adapter. | 1.18ms |
| missing-data-source | PASS | Fail explicitly without creating a report. | 18.53ms |
| evidence-conflict | PASS | Reject conflicting duplicates. | 3.14ms |
| report-persistence-failure | PASS | Fail without returning a report ID. | 16.29ms |
| approval-expired | PASS | Transition to EXPIRED and block execution. | 20.27ms |
| proposal-tampered | PASS | Reject the content hash mismatch. | 23.78ms |
| concurrent-execution | PASS | Persist exactly one Mock operation. | 111.38ms |
| response-lost | PASS | Remain UNKNOWN until reconciliation; do not rewrite. | 22.77ms |
| session-interrupted | PASS | Resume with parent trace and complete once. | 20.98ms |

通过：11/11。
