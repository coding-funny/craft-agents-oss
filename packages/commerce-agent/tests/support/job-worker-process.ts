#!/usr/bin/env bun
import { CommerceDatabase } from '../../src/storage/database.ts'
import { DurableJobRepository } from '../../src/jobs/repository.ts'

const [databasePath, workerId] = process.argv.slice(2)
if (!databasePath || !workerId) throw new Error('Usage: job-worker-process.ts <database-path> <worker-id>')
const store = new CommerceDatabase(databasePath)
const repository = new DurableJobRepository(store)
let processed = 0
let emptyPolls = 0
while (emptyPolls < 20) {
  const now = new Date().toISOString()
  const lease = repository.claim({ workerId, kinds: ['INVESTIGATE'], now, leaseMs: 5_000, maxActivePerTenant: 100 })
  if (!lease) {
    emptyPolls += 1
    await Bun.sleep(5)
    continue
  }
  emptyPolls = 0
  const token = { jobId: lease.jobId, owner: workerId, epoch: lease.leaseEpoch }
  if (!repository.checkpoint(token, 'processed', { workerId }, new Date().toISOString())) throw new Error('lease lost before checkpoint')
  if (!repository.succeed(token, new Date().toISOString())) throw new Error('lease lost before completion')
  processed += 1
}
store.close()
console.log(JSON.stringify({ workerId, processed }))
