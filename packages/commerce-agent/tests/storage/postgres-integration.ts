import { resolve } from 'node:path'
import { stableId } from '../../src/data/hash.ts'
import { createPostgresClient, runPostgresMigrations } from '../../src/storage/postgres/client.ts'
import { withPostgresSecurityContext } from '../../src/storage/postgres-security-context.ts'
import { localTestPrincipal } from '../../src/auth/local-test.ts'

const connectionString = process.env.COMMERCE_TEST_DATABASE_URL
if (!connectionString) {
  console.error('COMMERCE_TEST_DATABASE_URL is required; PostgreSQL integration was not executed.')
  process.exit(1)
}

const sql = createPostgresClient(connectionString)
try {
  const directory = resolve(import.meta.dir, '../../migrations/postgres')
  const first = await runPostgresMigrations(sql, directory)
  const second = await runPostgresMigrations(sql, directory)
  if (second.some(migration => migration.applied)) throw new Error('Repeated migration was not idempotent')

  const importId = stableId('import', { test: crypto.randomUUID() })
  const principal = localTestPrincipal({
    actorId: 'postgres-integration', tenantId: 'integration-tenant', shopIds: ['integration-shop'],
    roles: ['ADMIN'], authSource: 'service-identity',
  })
  try {
    await withPostgresSecurityContext(sql, principal, async tx => {
      await tx`
        INSERT INTO commerce_imports (
          import_id, tenant_id, shop_id, source_type, source_id, status,
          manifest_hash, manifest_json, created_at, updated_at
        ) VALUES (
          ${importId}, 'integration-tenant', 'integration-shop', 'SYNTHETIC_FIXTURE',
          'postgres-contract-test', 'VALIDATING', ${'0'.repeat(64)}, '{}'::jsonb, NOW(), NOW()
        )
      `
      throw new Error('intentional rollback')
    })
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'intentional rollback') throw error
  }
  const rows = await withPostgresSecurityContext(sql, principal, async scoped => scoped<Array<{ count: number }>>`
    SELECT COUNT(*)::int AS count FROM commerce_imports WHERE import_id = ${importId}
  `)
  if (rows[0]?.count !== 0) throw new Error('PostgreSQL transaction rollback left a partial import')
  console.log(JSON.stringify({
    status: 'POSTGRES_VERIFIED',
    migrations: first,
    repeatedMigrations: second,
    rollbackVerified: true,
  }, null, 2))
} finally {
  await sql.close()
}
