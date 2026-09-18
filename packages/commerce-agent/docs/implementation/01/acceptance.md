# 01 Acceptance Record

Status: `CODE_READY`; live-model acceptance is `BLOCKED_EXTERNAL`.

## Executed checks

| Command | Result |
| --- | --- |
| `bun run commerce:typecheck` | exit 0 |
| `bun run typecheck:shared` | exit 0 |
| `bun run commerce:test:agent` | 32 passed, 0 failed |
| `bun run commerce:test` | 107 passed, 0 failed; 334 assertions |
| `bun run commerce:eval:agent -- --suite smoke` | 5 development cases loaded, one per planned category |
| missing-scope example CLI | exit 2, one JSON `WAITING_INPUT` result |

The vertical acceptance test uses a scripted fake model, a real stdio MCP subprocess, fixture data, report validation, and SQLite. It queries two periods, reads immutable evidence, rejects incorrect report values, repairs within budget, persists a no-action report, and reads the report back before `REPORT_READY`.

## T01-T42 status

| Assertions | Status | Evidence / limitation |
| --- | --- | --- |
| T01-T06 | PASS | baseline audit; task/state/repository tests including transaction rollback |
| T07 | PASS | standardized model-port contract; driver is generation-only |
| T08-T10 | PASS | truncated turn cannot dispatch; cancellation and missing live credential fail closed |
| T11-T16 | PASS | allowlist, whole-batch rejection, trusted scope, evidence scope, environment isolation, adapter compatibility |
| T17-T23 | PASS | atomic in-process reservations, retry attempt settlement, unknown usage, batch budget, compaction, loop detection |
| T24 | PARTIAL | reactive fake changes report values from returned evidence; two live evidence variants remain in B08 |
| T25-T32 | PASS | false completion, report repair/exhaustion, read-back gate, redaction, no-action report, mixed-call rejection, cancellation terminal |
| T33-T35 | PASS | machine JSON/exit code, stale-version rejection, cross-process child Run with task version increment and parent link |
| T36 | PARTIAL | resources close in runner `finally`; a dedicated OS-signal subprocess test is not yet present |
| T37-T39 | PASS | 20 unique dev cases, fixed five-case smoke split, independent gold and deterministic negative grader |
| T40-T41 | BLOCKED_EXTERNAL | requires an explicitly authorized live model configuration and budget |
| T42 | PASS | current-worktree regression and scope inspection; final post-doc command is recorded in the execution log |

No live-model quality, production reliability, real-data performance, or merchant impact claim is supported by this record.
