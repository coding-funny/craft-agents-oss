import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createPostgresClient } from '../../src/storage/postgres/client.ts'
import { CommerceDatabase } from '../../src/storage/database.ts'
import { SqliteDataGovernanceRepository } from '../../src/storage/sqlite-data-governance-repository.ts'

describe('data governance storage contracts', () => {
  it('rolls back every write when a unit of work fails', async () => {
    const database = new CommerceDatabase(':memory:')
    const repository = new SqliteDataGovernanceRepository(database)
    await expect(repository.transaction(async () => {
      database.database.exec(`
        INSERT INTO commerce_imports (
          import_id, tenant_id, shop_id, source_type, source_id, status,
          manifest_hash, manifest_json, created_at, updated_at
        ) VALUES (
          'import_000000000000000000000000', 'tenant', 'shop', 'SYNTHETIC_FIXTURE',
          'source', 'VALIDATING', '${'0'.repeat(64)}', '{}',
          '2026-09-15T00:00:00Z', '2026-09-15T00:00:00Z'
        )
      `)
      throw new Error('injected commit failure')
    })).rejects.toThrow('injected commit failure')
    expect(database.database.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM commerce_imports').get()?.count).toBe(0)
    expect(database.database.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM commerce_snapshots').get()?.count).toBe(0)
    database.close()
  })

  it('ships an additive PostgreSQL migration with scoped foreign keys and indexes', async () => {
    const migration = await readFile(resolve(import.meta.dir, '../../migrations/postgres/0001_data_governance.sql'), 'utf8')
    for (const table of [
      'commerce_imports', 'commerce_record_versions', 'commerce_quarantine',
      'commerce_snapshots', 'commerce_snapshot_records', 'commerce_report_reviews',
    ]) expect(migration).toContain(`CREATE TABLE IF NOT EXISTS ${table}`)
    expect(migration).toContain('FOREIGN KEY (snapshot_id, tenant_id, shop_id)')
    expect(migration).toContain('idx_commerce_snapshots_scope_asof')
    expect(migration).not.toMatch(/\b(?:REAL|DOUBLE PRECISION)\b/)
  })

  it('rejects non-PostgreSQL production connection strings', () => {
    expect(() => createPostgresClient('sqlite://local.db')).toThrow('requires a PostgreSQL connection string')
  })
})
