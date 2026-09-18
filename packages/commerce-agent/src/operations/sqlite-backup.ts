import { Database } from 'bun:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { basename, resolve } from 'node:path'

const criticalTables = ['commerce_jobs', 'commerce_feedback', 'commerce_execution_requests', 'approvals'] as const

function tableDigest(db: Database, table: string): { count: number; digest: string } {
  const rows = db.query(`SELECT * FROM ${table} ORDER BY rowid`).all()
  return { count: rows.length, digest: createHash('sha256').update(JSON.stringify(rows)).digest('hex') }
}

export function createAndVerifySqliteBackup(input: { environment: 'fixture' | 'sandbox'; sourcePath: string; backupDirectory: string; confirmation: string }): { backupPath: string; integrity: string; tables: Record<string, { count: number; digest: string }> } {
  if (input.confirmation !== 'VERIFY_NON_PRODUCTION_BACKUP') throw new Error('Explicit non-production confirmation required')
  const sourcePath = resolve(input.sourcePath); const backupDirectory = resolve(input.backupDirectory)
  if (sourcePath === backupDirectory || basename(sourcePath) === '') throw new Error('Invalid backup paths')
  if (!existsSync(sourcePath) || !statSync(sourcePath).isFile()) throw new Error('Source database must be an existing file')
  mkdirSync(backupDirectory, { recursive: true })
  const backupPath = resolve(backupDirectory, `${basename(sourcePath)}.${randomUUID()}.backup.sqlite`)
  const source = new Database(sourcePath)
  try {
    source.exec('PRAGMA wal_checkpoint(FULL)')
    source.exec(`VACUUM INTO '${backupPath.replaceAll("'", "''")}'`)
    const restored = new Database(backupPath, { readonly: true })
    try {
      const integrity = String(restored.query<{ integrity_check: string }, []>('PRAGMA integrity_check').get()?.integrity_check ?? 'missing')
      if (integrity !== 'ok') throw new Error(`Backup integrity failed: ${integrity}`)
      const tables: Record<string, { count: number; digest: string }> = {}
      for (const table of criticalTables) {
        const before = tableDigest(source, table); const after = tableDigest(restored, table)
        if (before.count !== after.count || before.digest !== after.digest) throw new Error(`Backup verification mismatch: ${table}`)
        tables[table] = after
      }
      return { backupPath, integrity, tables }
    } finally { restored.close() }
  } finally { source.close() }
}
