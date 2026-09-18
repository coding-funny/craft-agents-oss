import type { Database } from 'bun:sqlite'
import {
  DataRecordVersionSchema,
  DataSnapshotSchema,
  ImportBatchResultSchema,
  type DataKind,
  type DataRecordVersion,
  type DataSnapshot,
  type ImportBatchResult,
} from '../data/contracts.ts'
import { stableId } from '../data/hash.ts'
import type { CommerceDatabase } from './database.ts'
import type {
  AppendRecordResult,
  CommitSnapshotInput,
  DataGovernanceRepository,
  DataGovernanceTransaction,
  QuarantineInput,
  RecordDisposition,
  ScopedDataRecordInput,
} from './ports/data-governance-repository.ts'

type JsonRow = { json: string }
type ExistingRecordRow = { record_version_id: string; version: number; content_hash: string }

function parseRecord(row: Record<string, unknown>): DataRecordVersion {
  return DataRecordVersionSchema.parse({
    recordVersionId: row.record_version_id,
    tenantId: row.tenant_id,
    shopId: row.shop_id,
    kind: row.kind,
    sourceRecordId: row.source_record_id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    version: row.version,
    contentHash: row.content_hash,
    payload: JSON.parse(String(row.payload_json)),
    businessTime: row.business_time,
    ingestedAt: row.ingested_at,
    importId: row.import_id,
  })
}

class SqliteDataGovernanceTransaction implements DataGovernanceTransaction {
  readonly #database: Database

  constructor(database: Database) {
    this.#database = database
  }

  async createImport(input: Parameters<DataGovernanceTransaction['createImport']>[0]): Promise<void> {
    const { scope, source } = input.manifest
    this.#database.query(`
      INSERT INTO commerce_imports (
        import_id, tenant_id, shop_id, source_type, source_id, status,
        manifest_hash, manifest_json, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, 'VALIDATING', ?6, ?7, ?8, ?8)
    `).run(
      input.importId,
      scope.tenantId,
      scope.shopId,
      source.sourceType,
      source.sourceId,
      input.manifestHash,
      JSON.stringify(input.manifest),
      input.createdAt,
    )
  }

  async appendRecord(input: ScopedDataRecordInput): Promise<AppendRecordResult> {
    const existing = latestRecord(this.#database, input)
    if (existing?.content_hash === input.contentHash) {
      return {
        disposition: 'duplicate',
        recordVersionId: existing.record_version_id,
        version: existing.version,
      }
    }

    const version = (existing?.version ?? 0) + 1
    const recordVersionId = stableId('record', {
      tenantId: input.tenantId,
      shopId: input.shopId,
      kind: input.kind,
      sourceId: input.sourceId,
      sourceRecordId: input.sourceRecordId,
      version,
      contentHash: input.contentHash,
    })
    this.#database.query(`
      INSERT INTO commerce_record_versions (
        record_version_id, tenant_id, shop_id, kind, source_record_id, source_type, source_id, version,
        content_hash, business_time, payload_json, import_id, ingested_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
    `).run(
      recordVersionId,
      input.tenantId,
      input.shopId,
      input.kind,
      input.sourceRecordId,
      input.sourceType,
      input.sourceId,
      version,
      input.contentHash,
      input.businessTime,
      JSON.stringify(input.payload),
      input.importId,
      input.ingestedAt,
    )
    return { disposition: existing ? 'revised' : 'accepted', recordVersionId, version }
  }

  async appendQuarantine(input: QuarantineInput): Promise<void> {
    const quarantineId = stableId('quarantine', {
      importId: input.importId,
      kind: input.kind,
      rowNumber: input.rowNumber,
    })
    this.#database.query(`
      INSERT INTO commerce_quarantine (
        quarantine_id, import_id, tenant_id, shop_id, kind, row_number,
        code, message, raw_json, created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
    `).run(
      quarantineId,
      input.importId,
      input.tenantId,
      input.shopId,
      input.kind,
      input.rowNumber,
      input.code,
      input.message,
      JSON.stringify(input.raw),
      input.createdAt,
    )
  }

  async commitSnapshot(input: CommitSnapshotInput): Promise<DataSnapshot> {
    const scope = input.manifest.scope
    const rows = this.#database.query<{ record_version_id: string }, [string, string]>(`
      SELECT current.record_version_id
      FROM commerce_record_versions current
      WHERE current.tenant_id = ?1 AND current.shop_id = ?2
        AND NOT EXISTS (
          SELECT 1 FROM commerce_record_versions newer
          WHERE newer.tenant_id = current.tenant_id
            AND newer.shop_id = current.shop_id
            AND newer.kind = current.kind
            AND newer.source_id = current.source_id
            AND newer.source_record_id = current.source_record_id
            AND newer.version > current.version
        )
      ORDER BY current.kind, current.source_record_id
    `).all(scope.tenantId, scope.shopId)
    const recordVersionIds = rows.map(row => row.record_version_id)
    const snapshotId = stableId('snapshot', {
      tenantId: scope.tenantId,
      shopId: scope.shopId,
      importId: input.importId,
      recordVersionIds,
    })
    const snapshot = DataSnapshotSchema.parse({
      snapshotId,
      tenantId: scope.tenantId,
      shopId: scope.shopId,
      sourceType: input.manifest.source.sourceType,
      sourceId: input.manifest.source.sourceId,
      currency: scope.currency,
      timezone: scope.timezone,
      asOf: input.asOf,
      importId: input.importId,
      recordVersionIds,
      completeness: input.completeness,
      metricDefinitionVersion: input.manifest.metricDefinitionVersion,
      createdAt: input.createdAt,
    })
    this.#database.query(`
      INSERT INTO commerce_snapshots (
        snapshot_id, tenant_id, shop_id, import_id, as_of, snapshot_json, created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
    `).run(
      snapshot.snapshotId,
      snapshot.tenantId,
      snapshot.shopId,
      snapshot.importId,
      snapshot.asOf,
      JSON.stringify(snapshot),
      snapshot.createdAt,
    )
    const membership = this.#database.query(`
      INSERT INTO commerce_snapshot_records (
        snapshot_id, record_version_id, tenant_id, shop_id
      ) VALUES (?1, ?2, ?3, ?4)
    `)
    for (const recordVersionId of recordVersionIds) {
      membership.run(snapshot.snapshotId, recordVersionId, snapshot.tenantId, snapshot.shopId)
    }
    const result = ImportBatchResultSchema.parse({
      importId: input.importId,
      status: input.status,
      snapshotId: snapshot.snapshotId,
      ...input.counts,
      completeness: input.completeness,
      issues: input.issues,
    })
    this.#database.query(`
      UPDATE commerce_imports SET status = ?2, result_json = ?3, updated_at = ?4
      WHERE import_id = ?1
    `).run(input.importId, input.status, JSON.stringify(result), input.createdAt)
    return snapshot
  }

  async rejectImport(importId: string, issues: CommitSnapshotInput['issues'], updatedAt: string): Promise<void> {
    const row = this.#database.query<{ result_json: string | null }, [string]>(
      'SELECT result_json FROM commerce_imports WHERE import_id = ?1',
    ).get(importId)
    if (!row) return
    const result = {
      importId,
      status: 'REJECTED',
      accepted: 0,
      revised: 0,
      duplicates: 0,
      quarantined: issues.length,
      completeness: {
        sales: 'missing', inventory: 'missing', promotions: 'missing', products: 'missing', ads: 'missing',
      },
      issues,
    }
    this.#database.query(`
      UPDATE commerce_imports SET status = 'REJECTED', result_json = ?2, updated_at = ?3
      WHERE import_id = ?1
    `).run(importId, JSON.stringify(ImportBatchResultSchema.parse(result)), updatedAt)
  }
}

function latestRecord(database: Database, input: Pick<ScopedDataRecordInput,
  'tenantId' | 'shopId' | 'kind' | 'sourceId' | 'sourceRecordId'>): ExistingRecordRow | undefined {
  return database.query<ExistingRecordRow, [string, string, DataKind, string, string]>(`
    SELECT record_version_id, version, content_hash
    FROM commerce_record_versions
    WHERE tenant_id = ?1 AND shop_id = ?2 AND kind = ?3 AND source_id = ?4 AND source_record_id = ?5
    ORDER BY version DESC LIMIT 1
  `).get(input.tenantId, input.shopId, input.kind, input.sourceId, input.sourceRecordId) ?? undefined
}

export class SqliteDataGovernanceRepository implements DataGovernanceRepository {
  readonly #database: Database
  #transactionTail: Promise<void> = Promise.resolve()

  constructor(database: CommerceDatabase | Database) {
    this.#database = 'database' in database ? database.database : database
  }

  async transaction<T>(work: (tx: DataGovernanceTransaction) => Promise<T>): Promise<T> {
    const previous = this.#transactionTail
    let release = (): void => undefined
    this.#transactionTail = new Promise<void>(resolve => { release = resolve })
    await previous
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const result = await work(new SqliteDataGovernanceTransaction(this.#database))
      this.#database.exec('COMMIT')
      return result
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    } finally {
      release()
    }
  }

  async classifyRecord(input: ScopedDataRecordInput): Promise<RecordDisposition> {
    const existing = latestRecord(this.#database, input)
    if (!existing) return 'accepted'
    return existing.content_hash === input.contentHash ? 'duplicate' : 'revised'
  }

  async getImport(importId: string): Promise<ImportBatchResult | undefined> {
    const row = this.#database.query<JsonRow, [string]>(`
      SELECT result_json AS json FROM commerce_imports
      WHERE import_id = ?1 AND result_json IS NOT NULL
    `).get(importId)
    return row ? ImportBatchResultSchema.parse(JSON.parse(row.json)) : undefined
  }

  async getSnapshot(scope: { tenantId: string; shopId: string; snapshotId: string }): Promise<DataSnapshot | undefined> {
    const row = this.#database.query<JsonRow, [string, string, string]>(`
      SELECT snapshot_json AS json FROM commerce_snapshots
      WHERE tenant_id = ?1 AND shop_id = ?2 AND snapshot_id = ?3
    `).get(scope.tenantId, scope.shopId, scope.snapshotId)
    return row ? DataSnapshotSchema.parse(JSON.parse(row.json)) : undefined
  }

  async resolveSnapshot(scope: { tenantId: string; shopId: string; asOf: string }): Promise<DataSnapshot | undefined> {
    const row = this.#database.query<JsonRow, [string, string, string]>(`
      SELECT snapshot_json AS json FROM commerce_snapshots
      WHERE tenant_id = ?1 AND shop_id = ?2 AND as_of <= ?3
      ORDER BY as_of DESC, created_at DESC LIMIT 1
    `).get(scope.tenantId, scope.shopId, scope.asOf)
    return row ? DataSnapshotSchema.parse(JSON.parse(row.json)) : undefined
  }

  async listSnapshotRecords(scope: {
    tenantId: string
    shopId: string
    snapshotId: string
    kind?: DataKind
  }): Promise<DataRecordVersion[]> {
    const rows = scope.kind
      ? this.#database.query<Record<string, unknown>, [string, string, string, DataKind]>(`
          SELECT records.* FROM commerce_snapshot_records membership
          JOIN commerce_record_versions records
            ON records.record_version_id = membership.record_version_id
            AND records.tenant_id = membership.tenant_id
            AND records.shop_id = membership.shop_id
          WHERE membership.tenant_id = ?1 AND membership.shop_id = ?2
            AND membership.snapshot_id = ?3 AND records.kind = ?4
          ORDER BY records.source_record_id
        `).all(scope.tenantId, scope.shopId, scope.snapshotId, scope.kind)
      : this.#database.query<Record<string, unknown>, [string, string, string]>(`
          SELECT records.* FROM commerce_snapshot_records membership
          JOIN commerce_record_versions records
            ON records.record_version_id = membership.record_version_id
            AND records.tenant_id = membership.tenant_id
            AND records.shop_id = membership.shop_id
          WHERE membership.tenant_id = ?1 AND membership.shop_id = ?2
            AND membership.snapshot_id = ?3
          ORDER BY records.kind, records.source_record_id
        `).all(scope.tenantId, scope.shopId, scope.snapshotId)
    return rows.map(parseRecord)
  }
}
