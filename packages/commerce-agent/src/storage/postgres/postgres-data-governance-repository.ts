import {
  DataRecordVersionSchema,
  DataSnapshotSchema,
  ImportBatchResultSchema,
  type DataKind,
  type DataRecordVersion,
  type DataSnapshot,
  type ImportBatchResult,
} from '../../data/contracts.ts'
import { stableId } from '../../data/hash.ts'
import type {
  AppendRecordResult,
  CommitSnapshotInput,
  DataGovernanceRepository,
  DataGovernanceTransaction,
  QuarantineInput,
  RecordDisposition,
  ScopedDataRecordInput,
} from '../ports/data-governance-repository.ts'

type PgRecordRow = {
  record_version_id: string
  tenant_id: string
  shop_id: string
  kind: DataKind
  source_record_id: string
  source_type: 'AUTHORIZED_EXPORT' | 'SYNTHETIC_FIXTURE' | 'HTTP_TEST_SOURCE'
  source_id: string
  version: number
  content_hash: string
  business_time: string | Date
  payload_json: unknown
  import_id: string
  ingested_at: string | Date
}

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value
}

function json(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value
}

function recordFromRow(row: PgRecordRow): DataRecordVersion {
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
    payload: json(row.payload_json),
    businessTime: iso(row.business_time),
    ingestedAt: iso(row.ingested_at),
    importId: row.import_id,
  })
}

async function latestRecord(sql: Bun.SQL, input: Pick<ScopedDataRecordInput,
  'tenantId' | 'shopId' | 'kind' | 'sourceId' | 'sourceRecordId'>, lock = false) {
  const suffix = lock ? ' FOR UPDATE' : ''
  const rows = await sql.unsafe<Array<{ record_version_id: string; version: number; content_hash: string }>>(`
    SELECT record_version_id, version, content_hash
    FROM commerce_record_versions
    WHERE tenant_id = $1 AND shop_id = $2 AND kind = $3 AND source_id = $4 AND source_record_id = $5
    ORDER BY version DESC LIMIT 1${suffix}
  `, [input.tenantId, input.shopId, input.kind, input.sourceId, input.sourceRecordId])
  return rows[0]
}

class PostgresDataGovernanceTransaction implements DataGovernanceTransaction {
  readonly #sql: Bun.SQL

  constructor(sql: Bun.SQL) {
    this.#sql = sql
  }

  async createImport(input: Parameters<DataGovernanceTransaction['createImport']>[0]): Promise<void> {
    await this.#sql`SELECT pg_advisory_xact_lock(hashtext(${
      `commerce-import:${input.manifest.scope.tenantId}:${input.manifest.scope.shopId}`
    }))`
    await this.#sql`
      INSERT INTO commerce_imports (
        import_id, tenant_id, shop_id, source_type, source_id, status,
        manifest_hash, manifest_json, created_at, updated_at
      ) VALUES (
        ${input.importId}, ${input.manifest.scope.tenantId}, ${input.manifest.scope.shopId},
        ${input.manifest.source.sourceType}, ${input.manifest.source.sourceId}, 'VALIDATING',
        ${input.manifestHash}, ${JSON.stringify(input.manifest)}::jsonb, ${input.createdAt}, ${input.createdAt}
      )
    `
  }

  async appendRecord(input: ScopedDataRecordInput): Promise<AppendRecordResult> {
    await this.#sql`SELECT pg_advisory_xact_lock(hashtext(${
      `commerce-record:${input.tenantId}:${input.shopId}:${input.kind}:${input.sourceId}:${input.sourceRecordId}`
    }))`
    const existing = await latestRecord(this.#sql, input, true)
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
    await this.#sql`
      INSERT INTO commerce_record_versions (
        record_version_id, tenant_id, shop_id, kind, source_record_id, source_type, source_id, version,
        content_hash, business_time, payload_json, import_id, ingested_at
      ) VALUES (
        ${recordVersionId}, ${input.tenantId}, ${input.shopId}, ${input.kind}, ${input.sourceRecordId},
        ${input.sourceType}, ${input.sourceId}, ${version},
        ${input.contentHash}, ${input.businessTime}, ${JSON.stringify(input.payload)}::jsonb,
        ${input.importId}, ${input.ingestedAt}
      )
    `
    return { disposition: existing ? 'revised' : 'accepted', recordVersionId, version }
  }

  async appendQuarantine(input: QuarantineInput): Promise<void> {
    const quarantineId = stableId('quarantine', {
      importId: input.importId,
      kind: input.kind,
      rowNumber: input.rowNumber,
    })
    await this.#sql`
      INSERT INTO commerce_quarantine (
        quarantine_id, import_id, tenant_id, shop_id, kind, row_number,
        code, message, raw_json, created_at
      ) VALUES (
        ${quarantineId}, ${input.importId}, ${input.tenantId}, ${input.shopId}, ${input.kind},
        ${input.rowNumber}, ${input.code}, ${input.message}, ${JSON.stringify(input.raw)}::jsonb, ${input.createdAt}
      )
    `
  }

  async commitSnapshot(input: CommitSnapshotInput): Promise<DataSnapshot> {
    const scope = input.manifest.scope
    const rows = await this.#sql<Array<{ record_version_id: string }>>`
      SELECT DISTINCT ON (kind, source_id, source_record_id) record_version_id
      FROM commerce_record_versions
      WHERE tenant_id = ${scope.tenantId} AND shop_id = ${scope.shopId}
      ORDER BY kind, source_id, source_record_id, version DESC
    `
    const recordVersionIds = rows.map(row => row.record_version_id).sort()
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
    await this.#sql`
      INSERT INTO commerce_snapshots (
        snapshot_id, tenant_id, shop_id, import_id, as_of, snapshot_json, created_at
      ) VALUES (
        ${snapshot.snapshotId}, ${snapshot.tenantId}, ${snapshot.shopId}, ${snapshot.importId},
        ${snapshot.asOf}, ${JSON.stringify(snapshot)}::jsonb, ${snapshot.createdAt}
      )
    `
    for (const recordVersionId of recordVersionIds) {
      await this.#sql`
        INSERT INTO commerce_snapshot_records (snapshot_id, record_version_id, tenant_id, shop_id)
        VALUES (${snapshot.snapshotId}, ${recordVersionId}, ${snapshot.tenantId}, ${snapshot.shopId})
      `
    }
    const result = ImportBatchResultSchema.parse({
      importId: input.importId,
      status: input.status,
      snapshotId,
      ...input.counts,
      completeness: input.completeness,
      issues: input.issues,
    })
    await this.#sql`
      UPDATE commerce_imports
      SET status = ${input.status}, result_json = ${JSON.stringify(result)}::jsonb, updated_at = ${input.createdAt}
      WHERE import_id = ${input.importId}
    `
    return snapshot
  }

  async rejectImport(importId: string, issues: CommitSnapshotInput['issues'], updatedAt: string): Promise<void> {
    const result = ImportBatchResultSchema.parse({
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
    })
    await this.#sql`
      UPDATE commerce_imports
      SET status = 'REJECTED', result_json = ${JSON.stringify(result)}::jsonb, updated_at = ${updatedAt}
      WHERE import_id = ${importId}
    `
  }
}

export class PostgresDataGovernanceRepository implements DataGovernanceRepository {
  readonly #sql: Bun.SQL

  constructor(sql: Bun.SQL) {
    this.#sql = sql
  }

  async transaction<T>(work: (tx: DataGovernanceTransaction) => Promise<T>): Promise<T> {
    return this.#sql.transaction(async sql => work(new PostgresDataGovernanceTransaction(sql)))
  }

  async classifyRecord(input: ScopedDataRecordInput): Promise<RecordDisposition> {
    const existing = await latestRecord(this.#sql, input)
    if (!existing) return 'accepted'
    return existing.content_hash === input.contentHash ? 'duplicate' : 'revised'
  }

  async getImport(importId: string): Promise<ImportBatchResult | undefined> {
    const rows = await this.#sql<Array<{ result_json: unknown }>>`
      SELECT result_json FROM commerce_imports
      WHERE import_id = ${importId} AND result_json IS NOT NULL
    `
    return rows[0] ? ImportBatchResultSchema.parse(json(rows[0].result_json)) : undefined
  }

  async getSnapshot(scope: { tenantId: string; shopId: string; snapshotId: string }): Promise<DataSnapshot | undefined> {
    const rows = await this.#sql<Array<{ snapshot_json: unknown }>>`
      SELECT snapshot_json FROM commerce_snapshots
      WHERE tenant_id = ${scope.tenantId} AND shop_id = ${scope.shopId} AND snapshot_id = ${scope.snapshotId}
    `
    return rows[0] ? DataSnapshotSchema.parse(json(rows[0].snapshot_json)) : undefined
  }

  async resolveSnapshot(scope: { tenantId: string; shopId: string; asOf: string }): Promise<DataSnapshot | undefined> {
    const rows = await this.#sql<Array<{ snapshot_json: unknown }>>`
      SELECT snapshot_json FROM commerce_snapshots
      WHERE tenant_id = ${scope.tenantId} AND shop_id = ${scope.shopId} AND as_of <= ${scope.asOf}
      ORDER BY as_of DESC, created_at DESC LIMIT 1
    `
    return rows[0] ? DataSnapshotSchema.parse(json(rows[0].snapshot_json)) : undefined
  }

  async listSnapshotRecords(scope: {
    tenantId: string
    shopId: string
    snapshotId: string
    kind?: DataKind
  }): Promise<DataRecordVersion[]> {
    const base = `
      SELECT records.* FROM commerce_snapshot_records membership
      JOIN commerce_record_versions records
        ON records.record_version_id = membership.record_version_id
        AND records.tenant_id = membership.tenant_id
        AND records.shop_id = membership.shop_id
      WHERE membership.tenant_id = $1 AND membership.shop_id = $2 AND membership.snapshot_id = $3
    `
    const rows = scope.kind
      ? await this.#sql.unsafe<PgRecordRow[]>(`${base} AND records.kind = $4 ORDER BY records.source_record_id`, [
          scope.tenantId, scope.shopId, scope.snapshotId, scope.kind,
        ])
      : await this.#sql.unsafe<PgRecordRow[]>(`${base} ORDER BY records.kind, records.source_record_id`, [
          scope.tenantId, scope.shopId, scope.snapshotId,
        ])
    return rows.map(recordFromRow)
  }
}
