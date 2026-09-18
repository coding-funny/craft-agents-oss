import type { Database } from 'bun:sqlite'
import type { CommerceDatabase } from '../storage/database.ts'

export type HealthResult = { status: 'UP' | 'READY' | 'NOT_READY'; checkedAt: string; checks: Record<string, { ok: boolean; detail: string }> }

export class WorkerHeartbeatRepository {
  readonly #db: Database
  constructor(store: CommerceDatabase) { this.#db = store.database }
  beat(input: { workerId: string; workerKind: string; startedAt: string; now: string; buildVersion: string; metadata?: unknown }): void {
    this.#db.query(`INSERT INTO commerce_worker_heartbeats (worker_id,worker_kind,started_at,heartbeat_at,build_version,metadata_json)
      VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT(worker_id) DO UPDATE SET heartbeat_at=excluded.heartbeat_at,build_version=excluded.build_version,metadata_json=excluded.metadata_json`).run(
      input.workerId, input.workerKind, input.startedAt, input.now, input.buildVersion, JSON.stringify(input.metadata ?? {}))
  }
}

export class HealthService {
  readonly #db: Database
  readonly #startedAt = Date.now()
  constructor(store: CommerceDatabase, private readonly options: { requiredWorkerKinds?: string[]; workerStaleMs?: number; now?: () => Date } = {}) { this.#db = store.database }

  liveness(): HealthResult { return { status: 'UP', checkedAt: this.#now(), checks: { process: { ok: true, detail: `uptimeMs=${Date.now() - this.#startedAt}` } } } }

  readiness(): HealthResult {
    const checks: HealthResult['checks'] = {}
    try { this.#db.query('SELECT 1').get(); checks.database = { ok: true, detail: 'query succeeded' } } catch { checks.database = { ok: false, detail: 'query failed' } }
    const requiredTables = ['commerce_jobs', 'commerce_feedback', 'commerce_execution_requests', 'commerce_worker_heartbeats']
    const tables = this.#db.query<{ name: string }, []>(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(row => row.name)
    const missingTables = requiredTables.filter(table => !tables.includes(table))
    checks.schema = { ok: missingTables.length === 0, detail: missingTables.length ? `missing=${missingTables.join(',')}` : 'required tables present' }
    const nowMs = Date.parse(this.#now()); const staleMs = this.options.workerStaleMs ?? 60_000
    for (const kind of this.options.requiredWorkerKinds ?? []) {
      const row = this.#db.query<{ heartbeat_at: string }, [string]>('SELECT heartbeat_at FROM commerce_worker_heartbeats WHERE worker_kind=?1 ORDER BY heartbeat_at DESC LIMIT 1').get(kind)
      const age = row ? nowMs - Date.parse(row.heartbeat_at) : Number.POSITIVE_INFINITY
      checks[`worker:${kind}`] = { ok: age <= staleMs, detail: row ? `heartbeatAgeMs=${age}` : 'heartbeat missing' }
    }
    return { status: Object.values(checks).every(item => item.ok) ? 'READY' : 'NOT_READY', checkedAt: this.#now(), checks }
  }
  #now(): string { return (this.options.now ?? (() => new Date()))().toISOString() }
}
