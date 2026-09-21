import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { createAndVerifySqliteBackup } from '../src/operations/sqlite-backup.ts'

const Config = z.object({ environment: z.enum(['fixture', 'sandbox']), sourcePath: z.string().min(1), backupDirectory: z.string().min(1), confirmation: z.literal('VERIFY_NON_PRODUCTION_BACKUP') }).strict()

function option(argv: string[], name: string): string {
  const index = argv.indexOf(name); const value = index >= 0 ? argv[index + 1] : undefined
  if (!value) throw new Error(`${name} is required`)
  return value
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const config = Config.parse(JSON.parse(await readFile(option(argv, '--config'), 'utf8')))
  console.log(JSON.stringify(createAndVerifySqliteBackup(config), null, 2))
}

if (import.meta.main) main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
