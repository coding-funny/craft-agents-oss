import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe('PostgreSQL durable queue migration', () => {
  it('contains skip-locked claim, fencing epoch, RLS, and execution ledger contracts', () => {
    const sql = readFileSync(resolve(import.meta.dir, '../../migrations/postgres/0003_durable_jobs_execution.sql'), 'utf8')
    expect(sql).toContain('FOR UPDATE SKIP LOCKED')
    expect(sql).toContain('lease_epoch = j.lease_epoch + 1')
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY')
    expect(sql).toContain('commerce_execution_requests')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS proposals')
    expect(sql).toContain('commerce_job_checkpoints_scope')
    expect(sql).toContain('shop_id text NOT NULL')
    expect(sql).toContain("current_setting('app.tenant_id', true)")
    expect(sql).toContain("current_setting('app.shop_ids', true)")
  })
})
