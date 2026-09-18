import { resolve } from 'node:path'
import { ImportService, type ImportMode } from '../imports/import-service.ts'
import { CommerceError } from '../domain/errors.ts'
import { CommerceDatabase } from '../storage/database.ts'
import type { DataGovernanceRepository } from '../storage/ports/data-governance-repository.ts'
import { createPostgresClient, runPostgresMigrations } from '../storage/postgres/client.ts'
import { PostgresDataGovernanceRepository } from '../storage/postgres/postgres-data-governance-repository.ts'
import { SqliteDataGovernanceRepository } from '../storage/sqlite-data-governance-repository.ts'
import { redactErrorMessage } from '../mcp/trace.ts'

type Options = {
  manifest: string
  mode: ImportMode
  sqlite?: string
  databaseUrl?: string
}

function parseArguments(argv: string[]): Options {
  const value = (name: string): string | undefined => {
    const index = argv.indexOf(name)
    return index >= 0 ? argv[index + 1] : undefined
  }
  const manifest = value('--manifest')
  const sqlite = value('--sqlite')
  const databaseUrl = value('--database-url') ?? process.env.COMMERCE_DATABASE_URL
  const modes = [argv.includes('--dry-run'), argv.includes('--apply')].filter(Boolean).length
  if (!manifest || modes !== 1) {
    throw new Error('Usage: import-data --manifest <path> (--dry-run|--apply) (--sqlite <path>|--database-url <postgres-url>)')
  }
  if ((sqlite ? 1 : 0) + (databaseUrl ? 1 : 0) !== 1) {
    throw new Error('Exactly one storage target is required: --sqlite or --database-url')
  }
  return { manifest, mode: argv.includes('--apply') ? 'apply' : 'dry-run', sqlite, databaseUrl }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = parseArguments(argv)
  let repository: DataGovernanceRepository
  let close: () => Promise<void> | void
  if (options.databaseUrl) {
    const sql = createPostgresClient(options.databaseUrl)
    await runPostgresMigrations(sql, resolve(import.meta.dir, '../../migrations/postgres'))
    repository = new PostgresDataGovernanceRepository(sql)
    close = () => sql.close()
  } else {
    const database = new CommerceDatabase(resolve(options.sqlite!))
    repository = new SqliteDataGovernanceRepository(database)
    close = () => database.close()
  }
  try {
    const result = await new ImportService(repository).run(resolve(options.manifest), options.mode)
    console.log(JSON.stringify(result, null, 2))
    if (result.status === 'REJECTED') process.exitCode = 3
  } finally {
    await close()
  }
}

if (import.meta.main) {
  main().catch(error => {
    console.error(redactErrorMessage(error instanceof Error ? error.message : String(error)))
    process.exitCode = error instanceof CommerceError
      ? error.code === 'SCOPE_DENIED' ? 4 : error.code === 'STORAGE_UNAVAILABLE' ? 5 : 2
      : error instanceof Error && error.name === 'ZodError' ? 2 : 5
  })
}
