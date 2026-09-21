import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { ImportedDataAdapter } from '../../src/adapters/imported-data-adapter.ts'
import { sha256 } from '../../src/data/hash.ts'
import { CommerceDatabase } from '../../src/storage/database.ts'
import { EvidenceRepository } from '../../src/evidence/evidence-repository.ts'
import { ImportService } from '../../src/imports/import-service.ts'
import { loadImportManifest } from '../../src/imports/manifest-loader.ts'
import { SqliteDataGovernanceRepository } from '../../src/storage/sqlite-data-governance-repository.ts'

const FIXTURE_MANIFEST = resolve(import.meta.dir, '../../fixtures/imports/synthetic-demo/manifest.json')
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function harness() {
  const database = new CommerceDatabase(':memory:')
  const repository = new SqliteDataGovernanceRepository(database)
  const service = new ImportService(repository, { now: () => '2026-09-15T09:01:00+08:00' })
  return { database, repository, service }
}

async function createManifestWithSales(rows: unknown[], overrides: Record<string, unknown> = {}): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), 'commerce-import-'))
  temporaryDirectories.push(directory)
  await mkdir(directory, { recursive: true })
  const sales = `${JSON.stringify(rows, null, 2)}\n`
  await writeFile(resolve(directory, 'sales.json'), sales)
  const manifest = {
    schemaVersion: 1,
    source: {
      sourceType: 'SYNTHETIC_FIXTURE',
      sourceId: 'synthetic-test-source',
      owner: 'test-suite',
      exportedAt: '2026-09-16T09:00:00+08:00',
    },
    scope: { tenantId: 'demo-tenant', shopId: 'demo-shop', currency: 'CNY', timezone: 'Asia/Shanghai' },
    businessWindow: { start: '2026-09-01T00:00:00+08:00', end: '2026-09-16T00:00:00+08:00' },
    mappingVersion: 'canonical-v1',
    metricDefinitionVersion: 'commerce-metrics-v1',
    files: [{ kind: 'sales', path: 'sales.json', format: 'json', sha256: sha256(sales), schemaVersion: 1 }],
    ...overrides,
  }
  const path = resolve(directory, 'manifest.json')
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`)
  return path
}

describe('governed import pipeline', () => {
  it('loads a strict manifest and validates every declared digest', async () => {
    const loaded = await loadImportManifest(FIXTURE_MANIFEST)
    expect(loaded.manifest.source.sourceType).toBe('SYNTHETIC_FIXTURE')
    expect(loaded.files).toHaveLength(5)

    const json = JSON.parse(await readFile(FIXTURE_MANIFEST, 'utf8'))
    json.unexpected = true
    const path = await createManifestWithSales([], json)
    await expect(loadImportManifest(path)).rejects.toThrow()
  })

  it('rejects unauthorized source claims, path escape, and digest mismatch before import', async () => {
    const authorizedWithoutReference = await createManifestWithSales([], {
      source: {
        sourceType: 'AUTHORIZED_EXPORT', sourceId: 'claimed-export', owner: 'test-owner',
        exportedAt: '2026-09-16T09:00:00+08:00',
      },
    })
    await expect(loadImportManifest(authorizedWithoutReference)).rejects.toThrow('authorization')

    const escaped = await createManifestWithSales([], {
      files: [{ kind: 'sales', path: '../outside.json', format: 'json', sha256: '0'.repeat(64), schemaVersion: 1 }],
    })
    await expect(loadImportManifest(escaped)).rejects.toThrow('escapes the manifest directory')

    const wrongDigest = await createManifestWithSales([], {
      files: [{ kind: 'sales', path: 'sales.json', format: 'json', sha256: '0'.repeat(64), schemaVersion: 1 }],
    })
    await expect(loadImportManifest(wrongDigest)).rejects.toThrow('digest does not match')
  })

  it('keeps dry-run read-only and applies one immutable snapshot atomically', async () => {
    const { database, repository, service } = harness()
    const dryRun = await service.run(FIXTURE_MANIFEST, 'dry-run')
    expect(dryRun.status).toBe('APPLIED')
    expect(dryRun.accepted).toBe(8)
    expect(database.database.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM commerce_imports').get()?.count).toBe(0)

    const applied = await service.run(FIXTURE_MANIFEST, 'apply')
    expect(applied.status).toBe('APPLIED')
    expect(applied.snapshotId).toMatch(/^snapshot_/)
    expect(applied.completeness).toEqual({
      sales: 'complete', inventory: 'complete', promotions: 'complete', products: 'complete', ads: 'complete',
    })
    expect(await service.run(FIXTURE_MANIFEST, 'apply')).toEqual(applied)
    expect(database.database.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM commerce_record_versions').get()?.count).toBe(8)
    expect(await repository.listSnapshotRecords({
      tenantId: 'demo-tenant', shopId: 'demo-shop', snapshotId: applied.snapshotId!,
    })).toHaveLength(8)
    database.close()
  })

  it('quarantines invalid rows instead of silently dropping them', async () => {
    const valid = {
      lineId: 'LINE-OK', orderId: 'ORDER-OK', shopId: 'demo-shop', productId: 'P-1', skuId: 'SKU-1',
      paidAt: '2026-09-10T10:00:00+08:00', quantity: 1, paidAmountMinor: 1000,
      currency: 'CNY', status: 'PAID', refunds: [],
    }
    const path = await createManifestWithSales([valid, { ...valid, lineId: 'LINE-BAD', hiddenField: 'must-fail' }])
    const { database, service } = harness()
    const result = await service.run(path, 'apply')
    expect(result.status).toBe('PARTIAL')
    expect(result.accepted).toBe(1)
    expect(result.quarantined).toBe(1)
    expect(result.issues[0]?.code).toBe('UNKNOWN_FIELDS')
    expect(database.database.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM commerce_quarantine').get()?.count).toBe(1)
    database.close()
  })

  it('creates a revision without mutating the older snapshot', async () => {
    const { database, repository, service } = harness()
    const first = await service.run(FIXTURE_MANIFEST, 'apply')
    const original = await repository.listSnapshotRecords({
      tenantId: 'demo-tenant', shopId: 'demo-shop', snapshotId: first.snapshotId!, kind: 'sales',
    })
    const rows = original.map(row => row.payload as Record<string, unknown>)
    const changedRows = rows.map(row => row.lineId === 'SYN-SALE-002' ? { ...row, paidAmountMinor: 45000 } : row)
    const revisionPath = await createManifestWithSales(changedRows, {
      source: {
        sourceType: 'SYNTHETIC_FIXTURE', sourceId: 'synthetic-commerce-demo-v1', owner: 'commerce-agent-test-suite',
        exportedAt: '2026-09-16T09:00:00+08:00',
      },
    })
    const second = await service.run(revisionPath, 'apply')
    expect(second.revised).toBe(1)
    expect(second.duplicates).toBe(1)
    expect(second.snapshotId).not.toBe(first.snapshotId)

    const oldRows = await repository.listSnapshotRecords({
      tenantId: 'demo-tenant', shopId: 'demo-shop', snapshotId: first.snapshotId!, kind: 'sales',
    })
    const newRows = await repository.listSnapshotRecords({
      tenantId: 'demo-tenant', shopId: 'demo-shop', snapshotId: second.snapshotId!, kind: 'sales',
    })
    expect((oldRows.find(row => row.sourceRecordId === 'SYN-SALE-002')?.payload as Record<string, unknown>).paidAmountMinor).toBe(40000)
    expect((newRows.find(row => row.sourceRecordId === 'SYN-SALE-002')?.payload as Record<string, unknown>).paidAmountMinor).toBe(45000)
    expect(await repository.getSnapshot({
      tenantId: 'other-tenant', shopId: 'demo-shop', snapshotId: second.snapshotId!,
    })).toBeUndefined()
    database.close()
  })

  it('serves 01 adapter contracts from one bound snapshot with governed evidence', async () => {
    const { database, repository, service } = harness()
    const result = await service.run(FIXTURE_MANIFEST, 'apply')
    const evidence = new EvidenceRepository(database)
    const adapter = new ImportedDataAdapter({
      repository,
      evidence,
      binding: { tenantId: 'demo-tenant', shopId: 'demo-shop', snapshotId: result.snapshotId! },
    })
    const query = {
      runId: 'run-import-test', caseId: 'case-import-test', traceId: 'trace-import-test',
      shopId: 'demo-shop', skuIds: ['SYN-SKU-001'],
      window: {
        start: '2026-09-08T00:00:00+08:00', end: '2026-09-15T00:00:00+08:00', timezone: 'Asia/Shanghai',
      },
      asOf: '2026-09-15T09:00:00+08:00', currency: 'CNY',
    }
    const sales = await adapter.querySales(query)
    const inventory = await adapter.queryInventory(query)
    const ads = await adapter.queryAds(query)
    const products = await adapter.queryProducts(query)
    expect(sales.data.map(row => row.lineId)).toEqual(['SYN-SALE-002'])
    expect(inventory.data.map(row => row.snapshotId)).toEqual(['SYN-INV-002'])
    expect(ads.data.map(row => row.recordId)).toEqual(['SYN-AD-002'])
    expect(products.data).toHaveLength(1)
    const record = evidence.getOrThrow(sales.evidence[0]!.evidenceId)
    expect(record.governance?.snapshotId).toBe(result.snapshotId)
    expect(record.governance?.sourceType).toBe('SYNTHETIC_FIXTURE')
    expect(record.governance?.sourceRecordIds).toEqual(['SYN-SALE-002'])
    await expect(adapter.querySales({ ...query, shopId: 'other-shop' })).rejects.toMatchObject({ code: 'SCOPE_DENIED' })
    database.close()
  })
})
