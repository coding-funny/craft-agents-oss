# 05 Evaluation ADR

## Decision

Model quality evidence is stored as immutable per-run `RunEvidence`. Every record binds the case, repeat number, run ID, variant, evidence mode, model identity, dataset/config digests, prompt/tool versions, grade, usage source, timings, runtime recovery metrics, safety counters, and review status.

Aggregation happens first by business task and then across tasks. Repeated runs estimate stability; they are not counted as independent business samples. Deterministic engineering tests, fake-model runs, live-model runs, and human review are reported separately.

## Evidence levels

- `EVAL_INFRA_READY`: schemas, aggregation, review queue, compare, and fail-closed gate are tested.
- `DATASET_FROZEN`: 40 dev and 20 family-isolated holdout tasks have executable data and licenses recorded.
- `MODEL_EVAL_VERIFIED`: locked live model/config completes all required repeats and passes the gate.
- `HUMAN_REVIEW_VERIFIED`: required holdout/high-risk/disagreement reviews are completed by named reviewers.

The repository currently contains 20 development seeds. They are not a frozen holdout and do not establish model accuracy.
