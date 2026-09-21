import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { ImportService } from '../../src/imports/import-service.ts'
import { createScopedCommerceClient } from '../../src/mcp/scoped-client.ts'
import { CommerceDatabase } from '../../src/storage/database.ts'
import { SqliteDataGovernanceRepository } from '../../src/storage/sqlite-data-governance-repository.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function payload(result: unknown): Record<string, any> {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content
  const text = content?.find(item => item.type === 'text')?.text
  if (!text) throw new Error('MCP response lacks a JSON text payload')
  return JSON.parse(text)
}

describe('imported snapshot MCP integration', () => {
  it('serves governed records through the same tool contract used by the investigation loop', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'commerce-imported-mcp-'))
    roots.push(root)
    const dbPath = resolve(root, 'commerce.sqlite')
    const database = new CommerceDatabase(dbPath)
    const imported = await new ImportService(new SqliteDataGovernanceRepository(database), {
      now: () => '2026-09-15T09:01:00+08:00',
    }).run(resolve(import.meta.dir, '../../fixtures/imports/synthetic-demo/manifest.json'), 'apply')
    database.close()

    const client = createScopedCommerceClient({
      dataMode: 'imported',
      tenantId: 'demo-tenant',
      snapshotId: imported.snapshotId!,
      shopId: 'demo-shop',
      reportDir: resolve(root, 'reports'),
      dbPath,
    })
    try {
      const result = payload(await client.callTool('query_sales', {
        run_id: 'run-imported-mcp', case_id: 'case-imported-mcp', trace_id: 'trace-imported-mcp',
        shop_id: 'demo-shop', sku_ids: ['SYN-SKU-001'],
        window: {
          start: '2026-09-08T00:00:00+08:00', end: '2026-09-15T00:00:00+08:00', timezone: 'Asia/Shanghai',
        },
        as_of: '2026-09-15T09:00:00+08:00', currency: 'CNY',
      }))
      expect(result.status).toBe('ok')
      expect(result.data.metrics.netSalesMinor.value).toBe(40000)
      expect(result.source).toContain(`snapshot:${imported.snapshotId}`)
      const evidence = payload(await client.callTool('get_evidence', {
        run_id: 'run-imported-mcp', case_id: 'case-imported-mcp', trace_id: 'trace-imported-mcp',
        shop_id: 'demo-shop', sku_ids: ['SYN-SKU-001'],
        window: {
          start: '2026-09-08T00:00:00+08:00', end: '2026-09-15T00:00:00+08:00', timezone: 'Asia/Shanghai',
        },
        as_of: '2026-09-15T09:00:00+08:00', currency: 'CNY', evidence_id: result.evidence[0].evidenceId,
      }))
      expect(evidence.data.governance.snapshotId).toBe(imported.snapshotId)
      expect(evidence.data.governance.sourceType).toBe('SYNTHETIC_FIXTURE')
    } finally {
      await client.close()
    }
  }, 20_000)
})
