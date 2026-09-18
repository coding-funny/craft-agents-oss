# 02 acceptance record

Date: 2026-09-18. Data mode used for local acceptance: `SYNTHETIC_FIXTURE` only.

## Verified locally

- Strict manifest and authorization declaration parsing.
- SHA-256 and manifest-directory path containment before row import.
- JSON, JSONL and CSV canonicalization for all five commerce data kinds.
- Dry-run zero writes; apply transaction, quarantine, duplicate detection and record revision.
- Immutable old snapshot after a changed source record creates a new revision.
- Tenant/shop-scoped snapshot lookup and snapshot-bound five-method `CommerceAdapter`.
- Imported snapshot through the real stdio MCP subprocess used by the 01 investigation dispatcher.
- Per-evidence snapshot/source/record lineage, freshness/completeness evaluation and report hard gates.
- Bounded HTTP 429 retry, pagination, snapshot-token drift, cursor expiry and cancellation.
- External semantic reviewer contradiction and unavailable-reviewer `PENDING_REVIEW` behavior.
- SQLite rollback after an injected unit-of-work failure.
- PostgreSQL migration shape, scoped foreign keys, additive indexes and URL fail-closed behavior.

## Commands and observed results

```text
cd packages/commerce-agent
bun run typecheck
# exit 0

bun test
# 124 pass, 0 fail, 402 expect() calls

bun run import -- --manifest fixtures/imports/synthetic-demo/manifest.json --dry-run --sqlite /tmp/commerce-02-cli.sqlite
# APPLIED preview: accepted=8, quarantined=0; database remained empty

bun run import -- --manifest fixtures/imports/synthetic-demo/manifest.json --apply --sqlite /tmp/commerce-agent-02-20260918.sqlite
# APPLIED: snapshot_d78b3298c042849e964d30a8, accepted=8

env -u COMMERCE_TEST_DATABASE_URL bun run test:postgres
# exit 1: explicit message that PostgreSQL integration was not executed
```

The HTTP tests require a temporary loopback listener. They passed when run with local-listener permission; failure to bind in the restricted network sandbox was not changed into a skip.

## Completion classification

Status is `CODE_READY / POSTGRES_AND_REAL_DATA_BLOCKED_EXTERNAL`.

Not verified here:

- Actual PostgreSQL server migration, repeated migration, rollback, concurrent revision and restart read.
- Any authorized merchant export or platform API.
- Any real-model run over imported data; 01 live-model B08 still requires explicit provider configuration and budget.

Accordingly, acceptable claims are “implemented governed import, immutable snapshot and evidence-lineage pipeline; verified with synthetic multi-format data and stdio MCP.” Claims of real merchant integration, PostgreSQL production verification or live-model quality are not supported yet.
