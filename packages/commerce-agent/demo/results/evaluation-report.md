# Commerce Agent 确定性评测报告

> 本报告是固定 Fixture 上的离线确定性回归，不是线上业务效果，也不是外部 LLM 质量评测。

## 概览

- 数据集：24 条（dev 16 / holdout 8）
- 通过：24；失败：0；通过率：100.00%
- 延迟：平均 15.73ms，P95 30.95ms

## 指标

| 指标 | 命中/样本 | 比率 |
| --- | ---: | ---: |
| toolSelectionAccuracy | 9/9 | 100.00% |
| argumentCorrectness | 13/13 | 100.00% |
| evidenceCoverage | 9/9 | 100.00% |
| numericCorrectness | 13/13 | 100.00% |
| rootCauseSupport | 7/7 | 100.00% |
| unsupportedClaimRate | 0/7 | 0.00% |
| reportCompletionRate | 7/7 | 100.00% |
| approvalSafety | 6/6 | 100.00% |
| idempotencySuccess | 4/4 | 100.00% |
| recoverySuccess | 2/2 | 100.00% |

除 `unsupportedClaimRate` 表示错误声明命中率（越低越好）外，其余指标表示通过率（越高越好）。

## 基线

- **single-turn-full-data-without-tools**：4/4，Uses the same fixture-derived conclusions but removes tool traces and repository-backed evidence; it is not an LLM measurement.
- **multi-step-without-governance-gates**：18/24，Keeps deterministic multi-step diagnosis but removes approval and execution gates; governance cases are therefore counted as failures.

## 消融

- **Skill/source binding**：保护路径=通过；移除机制后的反事实结果=失败。Without an explicit binding failure, the runner could silently execute outside the intended commerce context.
- **Evidence gate**：保护路径=通过；移除机制后的反事实结果=失败。A schema-only path cannot detect post-validation content changes or unsupported KPI values.
- **Retry budget**：保护路径=通过；移除机制后的反事实结果=失败。The bounded retry recovers one transient 429-equivalent failure; disabling retries fails the same probe immediately.
- **Approval hash validation**：保护路径=通过；移除机制后的反事实结果=失败。A status-only approval check would not bind the operator decision to immutable action content.
- **Idempotency ledger**：保护路径=通过；移除机制后的反事实结果=失败。Without a unique idempotency key, retries can apply the same business mutation twice.
- **Recovery state**：保护路径=通过；移除机制后的反事实结果=失败。Without persisted case state, an interrupted run cannot resume from its report and proposal identifiers.

## 失败案例

- 无

## 局限

- The 24 rows are synthetic deterministic regression cases over fixed fixtures, not 24 production merchant incidents.
- No external LLM is invoked, so prompt robustness, token cost, and model variance are not measured.
- Counterfactual baselines and ablations isolate engineering safeguards; they are not claims of model-quality uplift.
