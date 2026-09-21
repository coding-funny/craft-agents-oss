import {
  businessTime,
  emptyCompleteness,
  sourceRecordId,
  type CanonicalRecord,
  type DataKind,
  type ImportBatchResult,
  type ImportIssue,
} from '../data/contracts.ts'
import { contentHash, stableId } from '../data/hash.ts'
import type { DataGovernanceRepository, ScopedDataRecordInput } from '../storage/ports/data-governance-repository.ts'
import { loadImportManifest, type LoadedImportManifest } from './manifest-loader.ts'
import { loadRawRows, parseImportRows } from './record-loader.ts'

export type ImportMode = 'dry-run' | 'apply'

type PreparedRecord = {
  kind: DataKind
  rowNumber: number
  raw: unknown
  record: CanonicalRecord
  input: ScopedDataRecordInput
}

type PreparedImport = {
  records: PreparedRecord[]
  issues: ImportIssue[]
  rawIssues: Array<{ issue: ImportIssue; raw: unknown }>
}

export class ImportService {
  readonly #repository: DataGovernanceRepository
  readonly #now: () => string

  constructor(repository: DataGovernanceRepository, options?: { now?: () => string }) {
    this.#repository = repository
    this.#now = options?.now ?? (() => new Date().toISOString())
  }

  async run(manifestPath: string, mode: ImportMode): Promise<ImportBatchResult> {
    const loaded = await loadImportManifest(manifestPath)
    const importId = stableId('import', {
      manifest: loaded.manifest,
      manifestHash: loaded.manifestHash,
    })
    const existing = await this.#repository.getImport(importId)
    if (existing) return existing
    const prepared = this.#prepare(loaded, importId)
    if (mode === 'dry-run') return this.#dryRun(importId, prepared)
    return this.#apply(loaded, importId, prepared)
  }

  #prepare(loaded: LoadedImportManifest, importId: string): PreparedImport {
    const records: PreparedRecord[] = []
    const issues: ImportIssue[] = []
    const rawIssues: Array<{ issue: ImportIssue; raw: unknown }> = []
    const ingestedAt = this.#now()
    for (const file of loaded.files) {
      let rows
      try {
        rows = loadRawRows(file)
      } catch (error) {
        const issue = {
          kind: file.kind,
          row: 1,
          code: 'FILE_INVALID',
          message: error instanceof Error ? error.message : String(error),
        } as const
        issues.push(issue)
        rawIssues.push({ issue, raw: { file: file.path } })
        continue
      }
      for (const row of parseImportRows(file.kind, rows, loaded.manifest)) {
        if (!row.record) {
          const issue = {
            kind: file.kind,
            row: row.rowNumber,
            code: row.error?.code ?? 'INVALID_ROW',
            message: row.error?.message ?? 'row is invalid',
          }
          issues.push(issue)
          rawIssues.push({ issue, raw: row.value })
          continue
        }
        const record = row.record as Record<string, unknown>
        const id = sourceRecordId(file.kind, record)
        records.push({
          kind: file.kind,
          rowNumber: row.rowNumber,
          raw: row.value,
          record: row.record,
          input: {
            tenantId: loaded.manifest.scope.tenantId,
            shopId: loaded.manifest.scope.shopId,
            kind: file.kind,
            sourceRecordId: id,
            sourceType: loaded.manifest.source.sourceType,
            sourceId: loaded.manifest.source.sourceId,
            contentHash: contentHash(row.record),
            payload: row.record,
            businessTime: businessTime(file.kind, record, loaded.manifest.source.exportedAt),
            ingestedAt,
            importId,
          },
        })
      }
    }
    return { records, issues, rawIssues }
  }

  async #dryRun(
    importId: string,
    prepared: PreparedImport,
  ): Promise<ImportBatchResult> {
    const counts = { accepted: 0, revised: 0, duplicates: 0, quarantined: prepared.issues.length }
    const withinBatch = new Map<string, string>()
    for (const row of prepared.records) {
      const key = `${row.kind}:${row.input.sourceId}:${row.input.sourceRecordId}`
      const previousHash = withinBatch.get(key)
      const disposition = previousHash === row.input.contentHash
        ? 'duplicate'
        : previousHash
          ? 'revised'
          : await this.#repository.classifyRecord(row.input)
      withinBatch.set(key, row.input.contentHash)
      counts[disposition === 'duplicate' ? 'duplicates' : disposition] += 1
    }
    return {
      importId,
      status: prepared.records.length === 0 && prepared.issues.length > 0
        ? 'REJECTED'
        : prepared.issues.length > 0 ? 'PARTIAL' : 'APPLIED',
      ...counts,
      completeness: this.#completeness(prepared),
      issues: prepared.issues,
    }
  }

  async #apply(
    loaded: LoadedImportManifest,
    importId: string,
    prepared: PreparedImport,
  ): Promise<ImportBatchResult> {
    const createdAt = this.#now()
    return this.#repository.transaction(async tx => {
      await tx.createImport({ importId, manifest: loaded.manifest, manifestHash: loaded.manifestHash, createdAt })
      for (const item of prepared.rawIssues) {
        await tx.appendQuarantine({
          importId,
          tenantId: loaded.manifest.scope.tenantId,
          shopId: loaded.manifest.scope.shopId,
          kind: item.issue.kind,
          rowNumber: item.issue.row,
          code: item.issue.code,
          message: item.issue.message,
          raw: item.raw,
          createdAt,
        })
      }
      if (prepared.records.length === 0 && prepared.issues.length > 0) {
        await tx.rejectImport(importId, prepared.issues, createdAt)
        return (await this.#repository.getImport(importId)) ?? {
          importId,
          status: 'REJECTED',
          accepted: 0,
          revised: 0,
          duplicates: 0,
          quarantined: prepared.issues.length,
          completeness: this.#completeness(prepared),
          issues: prepared.issues,
        }
      }
      const counts = { accepted: 0, revised: 0, duplicates: 0, quarantined: prepared.issues.length }
      for (const row of prepared.records) {
        const result = await tx.appendRecord(row.input)
        counts[result.disposition === 'duplicate' ? 'duplicates' : result.disposition] += 1
      }
      const status = prepared.issues.length > 0 ? 'PARTIAL' : 'APPLIED'
      const snapshot = await tx.commitSnapshot({
        importId,
        manifest: loaded.manifest,
        asOf: loaded.manifest.source.exportedAt,
        completeness: this.#completeness(prepared),
        counts,
        issues: prepared.issues,
        status,
        createdAt,
      })
      return {
        importId,
        status,
        snapshotId: snapshot.snapshotId,
        ...counts,
        completeness: snapshot.completeness,
        issues: prepared.issues,
      }
    })
  }

  #completeness(prepared: PreparedImport) {
    const completeness = emptyCompleteness()
    const kindsWithRecords = new Set(prepared.records.map(row => row.kind))
    const kindsWithIssues = new Set(prepared.issues.map(issue => issue.kind))
    for (const kind of Object.keys(completeness) as DataKind[]) {
      if (kindsWithIssues.has(kind)) completeness[kind] = 'partial'
      else if (kindsWithRecords.has(kind)) completeness[kind] = 'complete'
    }
    return completeness
  }
}
