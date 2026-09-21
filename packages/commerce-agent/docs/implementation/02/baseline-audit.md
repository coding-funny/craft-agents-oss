# 02 baseline audit

Date: 2026-09-18. Branch: `codex/production-upgrade-02`. Parent implementation: `cda50438` (`feat(commerce): add production investigation runtime`).

## Starting point

- 01 already exposed one read-only `CommerceAdapter` with five scoped query methods and `AbortSignal` propagation.
- The investigation host already persisted task versions, run parentage, manifests, events and checkpoints in SQLite.
- Evidence IDs were content-derived, but evidence did not yet carry tenant/shop/snapshot/metric-definition lineage.
- The MCP server always constructed `FixtureAdapter`; imported records could not reach the dynamic investigation loop.
- Reports were projected to files before their database record was saved.

The user's pre-existing staged change in `packages/core/src/types/index.ts` was not edited and is excluded from the 02 commit.

## Environment probe

The local runtime is Bun 1.4.2 and includes the built-in `Bun.SQL` PostgreSQL client. No `docker`, `podman` or `psql` executable is available in this environment, and no explicit `COMMERCE_TEST_DATABASE_URL` was supplied.

Consequences:

- SQLite repository contracts, imports, snapshot queries, evidence gates, HTTP behavior and stdio MCP integration can be verified locally.
- PostgreSQL schema, migration runner and repository implementation can be typechecked and reviewed.
- Actual PostgreSQL migration, rollback, concurrent revision and restart verification remains external; it is not replaced by SQLite results.
- No authorized merchant export was supplied. Committed sample files are explicitly tagged `SYNTHETIC_FIXTURE`.

## Scope correction from the original plan

02 introduces the asynchronous storage boundary for governed data, snapshots and report review inputs. It does not rewrite Proposal/Approval/Execution repositories before 03 defines identity and policy or before 04 defines durable jobs. That split avoids freezing an incomplete authorization model while still giving 03 and 04 a scoped PostgreSQL schema and transaction pattern to reuse.
