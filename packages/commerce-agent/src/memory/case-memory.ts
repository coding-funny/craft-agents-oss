import { randomUUID } from 'node:crypto'
import type { Database } from 'bun:sqlite'
import type { AuthenticatedPrincipal } from '../auth/contracts.ts'
import { requirePermission, requireShopAccess } from '../auth/authorization.ts'
import { CommerceError } from '../domain/errors.ts'
import type { CommerceDatabase } from '../storage/database.ts'

export type CaseMemory = {
  memoryId: string; shopId: string; entityType: string; entityId: string; anomalyType: string; outcome: string
  reportId: string; evidenceIds: string[]; reviewedBy: string; reviewedAt: string; validUntil: string
}

type MemoryRow = {
  memory_id: string; shop_id: string; entity_type: string; entity_id: string; anomaly_type: string; outcome: string
  report_id: string; evidence_ids_json: string; reviewed_by: string; reviewed_at: string; valid_until: string
}

function fromRow(row: MemoryRow): CaseMemory { return { memoryId: row.memory_id, shopId: row.shop_id, entityType: row.entity_type, entityId: row.entity_id, anomalyType: row.anomaly_type, outcome: row.outcome, reportId: row.report_id, evidenceIds: JSON.parse(row.evidence_ids_json), reviewedBy: row.reviewed_by, reviewedAt: row.reviewed_at, validUntil: row.valid_until } }

export class CaseMemoryRepository {
  readonly #db: Database
  constructor(store: CommerceDatabase, private readonly now: () => Date = () => new Date()) { this.#db = store.database }

  saveReviewed(principal: AuthenticatedPrincipal, input: Omit<CaseMemory, 'memoryId' | 'reviewedBy' | 'reviewedAt'>): CaseMemory {
    requirePermission(principal, 'audit:read')
    requireShopAccess(principal, input.shopId)
    if (!principal.roles.includes('APPROVER') && !principal.roles.includes('ADMIN') && !principal.roles.includes('AUDITOR')) throw new CommerceError('SCOPE_DENIED', 'Reviewed case memory requires a review role')
    const now = this.now().toISOString()
    if (Date.parse(input.validUntil) <= Date.parse(now)) throw new CommerceError('INVALID_ARGUMENT', 'Case memory must have a future validity window')
    const memoryId = `memory_${randomUUID()}`
    this.#db.query(`INSERT INTO commerce_case_memory (memory_id,tenant_id,shop_id,entity_type,entity_id,anomaly_type,outcome,report_id,
      evidence_ids_json,reviewed_by,reviewed_at,valid_until,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?11)`).run(
      memoryId, principal.tenantId, input.shopId, input.entityType, input.entityId, input.anomalyType, input.outcome, input.reportId,
      JSON.stringify(input.evidenceIds), principal.actorId, now, input.validUntil)
    return { ...input, memoryId, reviewedBy: principal.actorId, reviewedAt: now }
  }

  search(principal: AuthenticatedPrincipal, query: { shopId: string; entityType?: string; entityId?: string; anomalyType?: string; limit?: number }): CaseMemory[] {
    requirePermission(principal, 'task:read')
    requireShopAccess(principal, query.shopId)
    const clauses = ['tenant_id=?1', 'shop_id=?2', 'valid_until>?3']
    const args: Array<string | number> = [principal.tenantId, query.shopId, this.now().toISOString()]
    for (const [column, value] of [['entity_type', query.entityType], ['entity_id', query.entityId], ['anomaly_type', query.anomalyType]] as const) {
      if (value) { clauses.push(`${column}=?${args.length + 1}`); args.push(value) }
    }
    args.push(Math.min(50, Math.max(1, query.limit ?? 10)))
    return this.#db.query<MemoryRow, Array<string | number>>(`SELECT * FROM commerce_case_memory WHERE ${clauses.join(' AND ')} ORDER BY reviewed_at DESC LIMIT ?${args.length}`).all(...args).map(fromRow)
  }
}
