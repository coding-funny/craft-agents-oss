import type {
  DataCompleteness,
  DataKind,
  DataRecordVersion,
  DataSnapshot,
  ImportBatchResult,
  ImportIssue,
  ImportManifest,
} from '../../data/contracts.ts'

export type ScopedDataRecordInput = {
  tenantId: string
  shopId: string
  kind: DataKind
  sourceRecordId: string
  sourceType: ImportManifest['source']['sourceType']
  sourceId: string
  contentHash: string
  payload: unknown
  businessTime: string
  ingestedAt: string
  importId: string
}

export type RecordDisposition = 'accepted' | 'revised' | 'duplicate'

export type AppendRecordResult = {
  disposition: RecordDisposition
  recordVersionId: string
  version: number
}

export type QuarantineInput = {
  importId: string
  tenantId: string
  shopId: string
  kind: DataKind
  rowNumber: number
  code: string
  message: string
  raw: unknown
  createdAt: string
}

export type CommitSnapshotInput = {
  importId: string
  manifest: ImportManifest
  asOf: string
  completeness: DataCompleteness
  counts: Pick<ImportBatchResult, 'accepted' | 'revised' | 'duplicates' | 'quarantined'>
  issues: ImportIssue[]
  status: 'APPLIED' | 'PARTIAL'
  createdAt: string
}

export interface DataGovernanceTransaction {
  createImport(input: { importId: string; manifest: ImportManifest; manifestHash: string; createdAt: string }): Promise<void>
  appendRecord(input: ScopedDataRecordInput): Promise<AppendRecordResult>
  appendQuarantine(input: QuarantineInput): Promise<void>
  commitSnapshot(input: CommitSnapshotInput): Promise<DataSnapshot>
  rejectImport(importId: string, issues: ImportIssue[], updatedAt: string): Promise<void>
}

export interface DataGovernanceRepository {
  transaction<T>(work: (tx: DataGovernanceTransaction) => Promise<T>): Promise<T>
  classifyRecord(input: ScopedDataRecordInput): Promise<RecordDisposition>
  getImport(importId: string): Promise<ImportBatchResult | undefined>
  getSnapshot(scope: { tenantId: string; shopId: string; snapshotId: string }): Promise<DataSnapshot | undefined>
  resolveSnapshot(scope: { tenantId: string; shopId: string; asOf: string }): Promise<DataSnapshot | undefined>
  listSnapshotRecords(scope: {
    tenantId: string
    shopId: string
    snapshotId: string
    kind?: DataKind
  }): Promise<DataRecordVersion[]>
}
