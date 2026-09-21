# 04 Handoff

## Stable contracts

- `DurableJobRepository`: enqueue, claim, heartbeat, checkpoint, retry, terminal transition, cancellation, expired-lease recovery.
- `DurableWorker`: registered handlers, heartbeat, cooperative abort, bounded retry/manual-review routing.
- `ActionExecutor`: capabilities, execute, lookup.
- `ReliableExecutionService`: PREPARED/SENT/UNKNOWN ledger and proposal-state reconciliation.
- `createTaskJobSink` and `createApprovalDecisionSink`: atomic task/proposal-to-job/outbox integration.

## Operational queries

Operators should monitor leased jobs past `lease_until`, retry age, `MANUAL_REVIEW`, outbox lag, UNKNOWN age, lookup attempts, and uncertainty deadline. Never repair an UNKNOWN row by resetting it to APPROVED or deleting its request/idempotency key.

## Next chains

05 should use failure outcomes, lookup count, recovery latency, and duplicate remote-effect count as evaluation dimensions. 06 should expose waiting input, cancellation, unknown, and manual-review queues without granting direct state mutation. 07 must execute real PostgreSQL migration/RLS/multi-worker tests and document shutdown, backup, and alert procedures.

## External verification still required

- PostgreSQL 15+ application role with RLS enabled.
- Authorized remote platform sandbox with documented idempotency and lookup semantics.
- Deployment process manager for independent API, worker, and outbox publisher processes.
