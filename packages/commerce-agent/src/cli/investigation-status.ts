#!/usr/bin/env bun
import { loadInvestigationConfig } from '../config/investigation.ts'
import { CommerceError } from '../domain/errors.ts'
import { CommerceDatabase } from '../storage/database.ts'
import { InvestigationRepository } from '../storage/investigation-repository.ts'

function valueFor(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

export async function statusCli(): Promise<number> {
  const runId = valueFor('--run')
  const configPath = valueFor('--config')
  if (!runId || !configPath) throw new CommerceError('INVALID_ARGUMENT', 'Usage: investigation-status --run <run-id> --config <config.json>')
  const config = await loadInvestigationConfig(configPath)
  const store = new CommerceDatabase(config.dbPath)
  try {
    const repository = new InvestigationRepository(store)
    const run = await repository.getRun(runId)
    process.stdout.write(`${JSON.stringify({ run, events: repository.listEvents(runId) })}\n`)
    return 0
  } finally {
    store.close()
  }
}

if (import.meta.main) {
  statusCli().then(code => { process.exitCode = code }).catch(error => {
    const normalized = error instanceof CommerceError
      ? { code: error.code, message: error.message }
      : { code: 'INTERNAL', message: error instanceof Error ? error.message : String(error) }
    process.stdout.write(`${JSON.stringify({ error: normalized })}\n`)
    process.exitCode = 1
  })
}
