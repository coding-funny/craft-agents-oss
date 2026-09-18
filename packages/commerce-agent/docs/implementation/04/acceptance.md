# 04 Acceptance record

## Local evidence

- Queue tests use two independent Bun processes and two independent SQLite connections.
- Lease expiry increments epoch; old owners cannot heartbeat, checkpoint, or complete.
- Tenant concurrency caps, queued/in-flight cancellation, bounded retry, manual review, and outbox ownership are asserted.
- HTTP tests use a separately stored loopback platform database. They cover apply-then-error, delayed visibility, stale target version, conflicting idempotency payload, and unsafe executor capabilities.
- Type checking and the full commerce regression suite are required before release.

## Evidence levels

- `CODE_READY`: local queue/runtime, independent HTTP platform, typecheck, and full regressions pass.
- `POSTGRES_VERIFIED`: migration is applied to a real PostgreSQL instance and two independent workers pass crash/takeover and RLS tests.
- `REMOTE_PLATFORM_VERIFIED`: an authorized non-test commerce platform passes capability and reconciliation tests.

The current local test platform is a fault-injection environment, not a real advertising platform. SQLite multi-process results are not PostgreSQL verification.
