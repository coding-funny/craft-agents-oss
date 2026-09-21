# 评测结论（2026-09-18）

## 确定性回归

- 数据集：24 条 synthetic regression cases，dev 16 / holdout 8。
- 结果：24/24 通过。
- 覆盖：诊断状态、参数与工具选择、Evidence、关键数值、因果措辞、审批安全、幂等与恢复。
- 原始结果：`demo/results/evaluation-results.json`。

各指标分母不同，只统计具备该检查项的样例：

| 指标 | 结果 |
| --- | ---: |
| Tool Selection Accuracy | 9/9 |
| Argument Correctness | 13/13 |
| Evidence Coverage | 9/9 |
| Numeric Correctness | 13/13 |
| Root-cause Support | 7/7 |
| Unsupported Claim Rate | 0/7 |
| Report Completion | 7/7 |
| Approval Safety | 6/6 |
| Idempotency Success | 4/4 |
| Recovery Success | 2/2 |

## 基线与消融

- 单轮全量数据反事实基线能复现 4/4 已知结论，但 Evidence Coverage 为 0；它不是 LLM 实测。
- 去治理多步基线为 18/24，审批/执行安全检查按失败计。
- 六项消融覆盖 Skill/Source 绑定、Evidence Gate、调用预算、审批哈希、幂等台账和恢复状态；移除机制后的结果是由对应故障探针构造的确定性反事实，不宣称模型质量提升百分比。

## 故障注入

11/11 通过：超时、429、非法 Schema、数据源缺失、Evidence 冲突、报告持久化失败、审批过期、Proposal 篡改、并发执行、响应丢失和会话中断恢复。

原始结果：`demo/results/failure-injection-results.json`。

## 局限

- 数据来自固定 Fixture，不是 24 个生产商家事故。
- 没有运行外部 LLM，不能声称模型任务准确率为 100%。
- 当前延迟主要是本地 SQLite 和固定计算，不代表网络平台或模型端到端延迟。
- 基线和消融用于验证工程安全机制，不是论文级因果实验。
