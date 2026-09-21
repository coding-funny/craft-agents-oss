import { randomUUID } from 'node:crypto'
import type { Database } from 'bun:sqlite'
import type { CommerceDatabase } from '../storage/database.ts'
import type { Detection, MonitorRuleConfig, MonitorScan } from './contracts.ts'

export type DetectedCase = {
  caseId: string; tenantId: string; shopId: string; entityType: string; entityId: string; anomalyType: string
  ruleVersion: string; severity: string; status: string; taskId?: string; firstWindowStart: string
  latestWindowEnd: string; cooldownUntil: string; notificationCount: number; createdAt: string; updatedAt: string
}

type CaseRow = {
  case_id: string; tenant_id: string; shop_id: string; entity_type: string; entity_id: string; anomaly_type: string
  rule_version: string; severity: string; status: string; task_id: string | null; first_window_start: string
  latest_window_end: string; cooldown_until: string; notification_count: number; created_at: string; updated_at: string
}

function fromRow(row: CaseRow): DetectedCase {
  return { caseId: row.case_id, tenantId: row.tenant_id, shopId: row.shop_id, entityType: row.entity_type, entityId: row.entity_id,
    anomalyType: row.anomaly_type, ruleVersion: row.rule_version, severity: row.severity, status: row.status, taskId: row.task_id ?? undefined,
    firstWindowStart: row.first_window_start, latestWindowEnd: row.latest_window_end, cooldownUntil: row.cooldown_until,
    notificationCount: row.notification_count, createdAt: row.created_at, updatedAt: row.updated_at }
}

const rank = { LOW: 0, MEDIUM: 1, HIGH: 2 } as const

export class MonitorRepository {
  readonly #db: Database
  constructor(store: CommerceDatabase) { this.#db = store.database }

  record(scan: MonitorScan, config: MonitorRuleConfig, detection: Detection, now: string): { item: DetectedCase; created: boolean; duplicate: boolean; severityEscalated: boolean } {
    return this.#db.transaction(() => {
      const existing = this.#db.query<CaseRow, [string, string, string, string, string, string]>(`SELECT * FROM commerce_detected_cases
        WHERE tenant_id=?1 AND shop_id=?2 AND entity_id=?3 AND anomaly_type=?4 AND rule_version=?5
          AND status IN ('OPEN','INVESTIGATING','DEFERRED') AND cooldown_until >= ?6
        ORDER BY updated_at DESC LIMIT 1`).get(scan.tenantId, scan.shopId, detection.entityId, detection.anomalyType, config.ruleVersion, scan.window.start)
      if (existing) {
        const duplicate = this.#observationExists(existing.case_id, scan.snapshotId)
        if (!duplicate) this.#insertObservation(existing.case_id, scan, detection, now)
        const escalated = rank[detection.severity] > rank[existing.severity as keyof typeof rank]
        if (!duplicate) this.#db.query(`UPDATE commerce_detected_cases SET latest_window_end=?1, severity=?2,
          notification_count=notification_count+?3, updated_at=?4 WHERE case_id=?5`).run(
          scan.window.end, escalated ? detection.severity : existing.severity, escalated ? 1 : 0, now, existing.case_id)
        return { item: fromRow(this.#get(existing.case_id)), created: false, duplicate, severityEscalated: escalated }
      }
      const caseId = `case_${randomUUID()}`
      const status = detection.anomalyType === 'DATA_INCOMPLETE' ? 'DEFERRED' : 'OPEN'
      const cooldownUntil = new Date(Date.parse(scan.window.end) + config.cooldownMs).toISOString()
      this.#db.query(`INSERT INTO commerce_detected_cases (case_id,tenant_id,shop_id,entity_type,entity_id,anomaly_type,
        rule_version,severity,status,first_window_start,latest_window_end,cooldown_until,created_at,updated_at)
        VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?13)`).run(
        caseId, scan.tenantId, scan.shopId, detection.entityType, detection.entityId, detection.anomalyType,
        config.ruleVersion, detection.severity, status, scan.window.start, scan.window.end, cooldownUntil, now)
      this.#insertObservation(caseId, scan, detection, now)
      return { item: fromRow(this.#get(caseId)), created: true, duplicate: false, severityEscalated: false }
    }).immediate()
  }

  attachTask(caseId: string, taskId: string, now: string): DetectedCase {
    this.#db.query("UPDATE commerce_detected_cases SET task_id=?1,status='INVESTIGATING',updated_at=?2 WHERE case_id=?3 AND task_id IS NULL").run(taskId, now, caseId)
    return fromRow(this.#get(caseId))
  }

  list(scope: { tenantId: string; shopIds: string[] }, limit = 100): DetectedCase[] {
    if (scope.shopIds.length === 0) return []
    const placeholders = scope.shopIds.map(() => '?').join(',')
    const rows = this.#db.query<CaseRow, string[]>(`SELECT * FROM commerce_detected_cases WHERE tenant_id=? AND shop_id IN (${placeholders}) ORDER BY updated_at DESC LIMIT ?`).all(scope.tenantId, ...scope.shopIds, String(limit))
    return rows.map(fromRow)
  }

  #get(caseId: string): CaseRow { return this.#db.query<CaseRow, [string]>('SELECT * FROM commerce_detected_cases WHERE case_id=?1').get(caseId)! }
  #observationExists(caseId: string, snapshotId: string): boolean { return Boolean(this.#db.query('SELECT 1 FROM commerce_case_observations WHERE case_id=?1 AND snapshot_id=?2').get(caseId, snapshotId)) }
  #insertObservation(caseId: string, scan: MonitorScan, detection: Detection, now: string): void {
    this.#db.query(`INSERT INTO commerce_case_observations (observation_id,case_id,snapshot_id,window_start,window_end,severity,reason,metrics_json,created_at)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)`).run(`obs_${randomUUID()}`, caseId, scan.snapshotId, scan.window.start, scan.window.end, detection.severity, detection.reason, JSON.stringify(detection.metrics), now)
  }
}
