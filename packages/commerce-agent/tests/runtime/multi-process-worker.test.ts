import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { CommerceDatabase } from '../../src/storage/database.ts'
import { DurableJobRepository } from '../../src/jobs/repository.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('multi-process durable workers', () => {
  it('claims every job once across two independent Bun processes', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'commerce-worker-process-'))
    roots.push(root)
    const path = resolve(root, 'runtime.sqlite')
    const store = new CommerceDatabase(path)
    const repository = new DurableJobRepository(store)
    const now = new Date().toISOString()
    for (let index = 0; index < 20; index += 1) {
      repository.enqueue({
        kind: 'INVESTIGATE', tenantId: `tenant-${index % 2}`, shopId: `shop-${index % 2}`,
        businessKey: `task-${index}`, payload: { index }, now,
      })
    }
    store.close()
    const script = resolve(import.meta.dir, '../support/job-worker-process.ts')
    const workers = ['worker-a', 'worker-b'].map(workerId => Bun.spawn({
      cmd: [process.execPath, 'run', script, path, workerId], stdout: 'pipe', stderr: 'pipe',
    }))
    expect(await Promise.all(workers.map(worker => worker.exited))).toEqual([0, 0])
    const verification = new CommerceDatabase(path)
    expect(verification.database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM commerce_jobs WHERE status = 'SUCCEEDED'").get()?.count).toBe(20)
    expect(verification.database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM commerce_job_checkpoints WHERE checkpoint_key = 'processed'").get()?.count).toBe(20)
    expect(verification.database.query<{ count: number }, []>('SELECT COUNT(DISTINCT job_id) AS count FROM commerce_job_checkpoints').get()?.count).toBe(20)
    verification.close()
  })
})
