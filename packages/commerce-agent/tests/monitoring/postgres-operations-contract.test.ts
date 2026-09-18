import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe('PostgreSQL operations migration', () => {
  it('covers every scoped operations table with forced RLS', () => {
    const sql = readFileSync(resolve(import.meta.dir, '../../migrations/postgres/0004_operations_feedback.sql'), 'utf8')
    for (const table of ['commerce_detected_cases', 'commerce_case_observations', 'commerce_feedback', 'commerce_eval_candidates', 'commerce_case_memory']) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`)
      expect(sql).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`)
    }
    expect(sql).toContain("current_setting('app.tenant_id',true)")
    expect(sql).toContain("current_setting('app.shop_ids',true)")
    expect(sql).toContain('UNIQUE(case_id, snapshot_id)')
    expect(sql).toContain('UNIQUE(tenant_id, actor_id, idempotency_key)')
  })
})
