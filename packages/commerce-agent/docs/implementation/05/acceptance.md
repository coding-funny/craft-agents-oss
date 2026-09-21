# 05 Acceptance and handoff

## Implemented locally

- strict run evidence and release policy schemas;
- task-level repeated-run aggregation, cost/latency/runtime/safety statistics;
- fake/live and unknown-cost fail-closed behavior;
- human review queue and completed-review accounting;
- comparable-report checks and auditable deltas;
- dataset/gold separation validation and stable development digest;
- offline eval contract tests in CI.

## Current blockers

- Dataset: only 20 development seeds exist; 40 dev + 20 independent holdout target is not yet met.
- Live model: no approved model configuration or evaluation budget was supplied.
- Human review: no reviewer assignments or completed review records exist.
- Data: no authorized real merchant evaluation windows are available.

Consequently the current status is `EVAL_INFRA_READY / DATASET_EXPANSION_PENDING / MODEL_EVAL_PENDING / HUMAN_REVIEW_PENDING`. No model-quality or cost improvement is claimed.

## Commands

```bash
bun run commerce:eval:validate
bun run commerce:test:eval-agent
bun run commerce:eval:report -- --evidence <runs.jsonl> --repeats 3 --output <report.json>
bun run commerce:eval:gate -- --report <report.json> --policy <release-policy.json>
bun run commerce:eval:compare -- --base <base.json> --candidate <candidate.json>
```

06 should consume pending human-review reasons and failure categories. 07 should run the locked live gate in the deployment environment and archive immutable reports.
