# 04 Runtime ADR: durable jobs and fencing

## Decision

Commerce investigation and approved actions run as durable jobs. Delivery is at-least-once; correctness comes from a stable business key, remote idempotency, atomic target-version checks, and reconciliation. The system does not claim general exactly-once execution.

SQLite is the local development implementation. It claims work in an `IMMEDIATE` short transaction. PostgreSQL production migration exposes a `FOR UPDATE SKIP LOCKED` claim function. Both increment `lease_epoch` on each claim. Heartbeat, checkpoint, retry, and terminal writes require `(job_id, lease_owner, lease_epoch)` and an unexpired lease.

## Boundaries

- No model or HTTP call is held inside a database transaction.
- Task/proposal decision, job, and outbox rows commit atomically.
- Only tasks with a resolved shop enter the worker queue. Unresolved tasks remain durable in `investigation_tasks` awaiting scoped input; no synthetic shop grant is created.
- A queued cancellation becomes `CANCELLED`; an in-flight cancellation only sets a request flag.
- Tenant active-lease limits prevent one tenant from consuming every worker slot.
- Exhausted retries become `MANUAL_REVIEW`; they are not silently dropped.

## Consequences

SQLite validates application semantics and multi-process recovery but is not evidence for PostgreSQL concurrency. PostgreSQL verification remains a separate environment gate.
