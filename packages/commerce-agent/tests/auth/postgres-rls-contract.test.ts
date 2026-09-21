import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe('PostgreSQL authorization migration contract', () => {
  it('forces RLS on governed tables and binds tenant, subject, and shop settings', () => {
    const migration = readFileSync(resolve(import.meta.dir, '../../migrations/postgres/0002_identity_authorization_rls.sql'), 'utf8')
    for (const table of ['commerce_imports', 'commerce_record_versions', 'commerce_snapshots', 'commerce_report_reviews']) {
      expect(migration).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`)
    }
    expect(migration).toContain("current_setting('app.tenant_id', true)")
    expect(migration).toContain("current_setting('app.shop_ids', true)")
    expect(migration).toContain("current_setting('app.subject', true)")
  })
})
