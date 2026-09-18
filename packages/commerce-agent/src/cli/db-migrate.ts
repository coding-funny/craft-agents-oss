import { resolve } from 'node:path'
import { createPostgresClient, runPostgresMigrations } from '../storage/postgres/client.ts'
import { redactErrorMessage } from '../mcp/trace.ts'

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const index = argv.indexOf('--database-url')
  const connectionString = index >= 0 ? argv[index + 1] : process.env.COMMERCE_DATABASE_URL
  if (!connectionString) throw new Error('PostgreSQL URL is required via --database-url or COMMERCE_DATABASE_URL')
  const sql = createPostgresClient(connectionString)
  try {
    const results = await runPostgresMigrations(sql, resolve(import.meta.dir, '../../migrations/postgres'))
    console.log(JSON.stringify({ migrations: results }, null, 2))
  } finally {
    await sql.close()
  }
}

if (import.meta.main) {
  main().catch(error => {
    console.error(redactErrorMessage(error instanceof Error ? error.message : String(error)))
    process.exitCode = 5
  })
}
