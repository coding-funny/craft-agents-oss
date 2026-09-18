# 02 handoff

Status: `CODE_READY / POSTGRES_AND_REAL_DATA_BLOCKED_EXTERNAL`.

## Stable interfaces for downstream work

- `DataGovernanceRepository` and `DataGovernanceTransaction` define async, scoped import/snapshot storage.
- `ImportService.run(manifestPath, 'dry-run' | 'apply')` is the controlled file entry point.
- `SnapshotService.bind` resolves one snapshot at a trusted tenant/shop/asOf.
- `ImportedDataAdapter` implements the unchanged 01 `CommerceAdapter` contract.
- Imported investigation config uses `dataMode: "imported"`, `snapshotId` and `snapshotShopId`; the MCP child receives only an explicit environment allowlist.
- `evaluateSnapshotHealth`, `evidenceSetHealth`, `assertGovernedEvidenceConsistency` and `reviewReportClaims` are the 03/04 policy inputs.
- PostgreSQL entry points are `createPostgresClient`, `runPostgresMigrations` and `PostgresDataGovernanceRepository`.

The existing task field is still named `fixtureDigest` for 01 schema compatibility. In imported mode it stores a digest of the bound snapshot, not a claim that the source is a fixture. A future schema migration may rename this to `dataSnapshotDigest`; 03 should not use its field name to infer provenance.

## Commands

```bash
bun run commerce:import -- --manifest <manifest.json> --dry-run --sqlite <local.sqlite>
bun run commerce:import -- --manifest <manifest.json> --apply --database-url <postgres-url>
bun run commerce:db:migrate -- --database-url <postgres-url>
bun run commerce:test:storage
bun run commerce:test:imports
bun run commerce:test:evidence
COMMERCE_TEST_DATABASE_URL=<postgres-test-url> bun run commerce:test:postgres
```

Production configuration must choose PostgreSQL explicitly. The imported MCP mode currently uses the shared local SQLite file for deterministic local investigation tests; switching the MCP child to PostgreSQL requires passing a connection reference through the host's secret/config mechanism, not inheriting the parent environment.

## 03 adjustments

03 should now build identity policy around the scope already present on imports, record versions, snapshots and governed evidence:

1. Bind authenticated principal/tenant/shop before snapshot resolution; return not-found semantics for out-of-scope IDs.
2. Add PostgreSQL row-level/security-in-depth tests in addition to repository predicates.
3. Persist claim review state and require policy-approved review status before creating high-risk proposals.
4. Migrate Proposal/Approval/Audit repositories to the async transaction boundary after actor and role semantics are frozen.
5. Treat `authorizationRef` as an auditable reference, not proof by itself; 03 owns validation against the actual authorization registry.

## External verification procedure

With a disposable PostgreSQL URL, run `commerce:test:postgres`, then apply the synthetic manifest and query through `ImportedDataAdapter`; record server version and migration checksum. With an authorized export, keep raw files outside Git, create a redacted manifest, reconcile row counts and sampled monetary totals, and record owner/authorization reference. Only after those steps may the corresponding completion flags move to verified.
