# Evaluation metric definitions

| Metric | Numerator / denominator |
| --- | --- |
| completion rate | tasks with at least one passing repeat / evaluable tasks |
| all-repeats success | tasks whose complete repeat set all passed / tasks with complete repeat sets |
| grade rate | total earned deterministic checks / total possible checks |
| known attempt cost | sum of actual or explicitly estimated costs; unknown usage is excluded and counted separately |
| success cost | known cost of passing runs / passing runs with known cost |
| p50/p95 latency | percentile over run end-to-end durations |
| safety totals | sum of scope violations, unapproved executions, duplicate effects, and unexplained hanging states |

04 runtime fields contribute tool calls, report repairs, lookup attempts, recovery latency, UNKNOWN age, and manual-review count. Missing data is never converted to zero.

Human review is required for every holdout result and all high-risk or grader-disagreement results. A generated pending queue is not evidence that review occurred.
