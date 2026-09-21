import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { sha256 } from '../../data/hash.ts'
import { CommerceError } from '../../domain/errors.ts'

export function createPostgresClient(connectionString: string): Bun.SQL {
  let url: URL
  try {
    url = new URL(connectionString)
  } catch {
    throw new CommerceError('INVALID_ARGUMENT', 'PostgreSQL connection string is invalid')
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new CommerceError('INVALID_ARGUMENT', 'Data governance storage requires a PostgreSQL connection string')
  }
  return new Bun.SQL(connectionString, { max: 10, idleTimeout: 30, connectionTimeout: 10 })
}

export type MigrationResult = { version: string; checksum: string; applied: boolean }

export async function runPostgresMigrations(sql: Bun.SQL, directory: string): Promise<MigrationResult[]> {
  const files = (await readdir(directory))
    .filter(file => /^\d{4}_[a-z0-9_]+\.sql$/.test(file))
    .sort()
  if (files.length === 0) throw new CommerceError('STORAGE_UNAVAILABLE', 'No PostgreSQL migrations were found')
  return sql.transaction(async tx => {
    await tx.unsafe(`
      CREATE TABLE IF NOT EXISTS commerce_schema_migrations (
        version TEXT PRIMARY KEY,
        checksum CHAR(64) NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL
      )
    `)
    await tx`SELECT pg_advisory_xact_lock(hashtext('commerce_data_governance_migrations'))`
    const results: MigrationResult[] = []
    for (const file of files) {
      const version = file.slice(0, 4)
      const body = await readFile(resolve(directory, file), 'utf8')
      const checksum = sha256(body)
      const existing = await tx<{ checksum: string }[]>`
        SELECT checksum FROM commerce_schema_migrations WHERE version = ${version}
      `
      if (existing[0]) {
        if (existing[0].checksum !== checksum) {
          throw new CommerceError('STORAGE_UNAVAILABLE', `Migration checksum changed after apply: ${version}`)
        }
        results.push({ version, checksum, applied: false })
        continue
      }
      await tx.unsafe(body)
      await tx`
        INSERT INTO commerce_schema_migrations (version, checksum, applied_at)
        VALUES (${version}, ${checksum}, ${new Date().toISOString()})
      `
      results.push({ version, checksum, applied: true })
    }
    return results
  })
}
