# ADR: governed data storage and immutable snapshots

Status: accepted for 02 CODE_READY.

## Decision

Use an asynchronous `DataGovernanceRepository` contract with two implementations:

- SQLite is the executable local contract implementation and powers deterministic tests and the imported-data MCP mode.
- PostgreSQL is the production storage target, implemented with Bun's built-in `SQL` client and additive, checksummed migrations.

Every data row, snapshot membership and review row carries tenant/shop scope. Record identity is `(tenant, shop, kind, sourceId, sourceRecordId)`; changed content creates a monotonically increasing revision, while identical content is a duplicate. An applied import creates an immutable snapshot containing the latest record version for every scoped source record.

## Transaction boundary

One apply transaction creates the import batch, appends record revisions and quarantined rows, creates snapshot membership, writes counts/completeness and advances the batch to `APPLIED` or `PARTIAL`. A failure rolls the whole transaction back. A batch with no valid rows becomes `REJECTED` and has no queryable snapshot.

`dry-run` parses, validates and classifies without writing. Repeating the same manifest resolves the same deterministic import and does not add rows or metrics.

## Snapshot binding

`ImportedDataAdapter` is constructed with trusted `{tenantId, shopId, snapshotId}`. The model cannot choose a database, source path, tenant or snapshot. All five existing 01 query methods read only snapshot membership, so a run cannot observe an import arriving between two tool calls.

The snapshot records its creating source, while each record version also retains source type, source ID and import ID. Evidence lists all contributing sources; `mixed` in the human-readable source label is never used to hide per-record lineage.

## PostgreSQL behavior

Migrations are sorted by version, SHA-256 checked and run inside a transaction protected by a PostgreSQL advisory lock. A previously applied version with a different checksum fails startup. The production URL must use `postgres:` or `postgresql:`. Missing/failed PostgreSQL configuration never falls back to SQLite.

The command `bun run commerce:test:postgres` deliberately exits non-zero when `COMMERCE_TEST_DATABASE_URL` is absent. Passing SQLite tests therefore cannot be reported as PostgreSQL verification.

## Alternatives rejected

- Direct model file/SQL tools: rejected because they bypass host scope, manifest authorization and stable evidence lineage.
- Mutable “current data” queries: rejected because reports would mix versions and cease to be replayable.
- Deduplication by payload alone: rejected because equal payloads from distinct sources are not the same source record.
- Replacing every old repository in 02: deferred because approval identity and job leasing contracts are owned by 03/04.
