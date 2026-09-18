import type { Database } from 'bun:sqlite'
import type { CommerceDatabase } from '../storage/database.ts'

export class CommerceMetrics {
  readonly #db: Database
  constructor(store: CommerceDatabase) { this.#db = store.database }
  render(now = new Date()): string {
    const count = (sql: string) => this.#db.query<{ value: number }, []>(sql).get()?.value ?? 0
    const values: Array<[string, string, number]> = [
      ['commerce_jobs_ready', 'Jobs available for workers', count("SELECT COUNT(*) AS value FROM commerce_jobs WHERE status IN ('READY','RETRY_WAIT')")],
      ['commerce_jobs_leased', 'Jobs with active leases', count("SELECT COUNT(*) AS value FROM commerce_jobs WHERE status='LEASED'")],
      ['commerce_jobs_manual_review', 'Jobs requiring manual review', count("SELECT COUNT(*) AS value FROM commerce_jobs WHERE status='MANUAL_REVIEW'")],
      ['commerce_execution_unknown', 'Execution requests with uncertain outcome', count("SELECT COUNT(*) AS value FROM commerce_execution_requests WHERE status='UNKNOWN'")],
      ['commerce_feedback_pending_review', 'Evaluation candidates pending review', count("SELECT COUNT(*) AS value FROM commerce_eval_candidates WHERE status='PENDING_REVIEW'")],
      ['commerce_worker_heartbeat_stale', 'Worker heartbeats older than sixty seconds', count(`SELECT COUNT(*) AS value FROM commerce_worker_heartbeats WHERE heartbeat_at < '${new Date(now.getTime() - 60_000).toISOString()}'`)],
    ]
    return `${values.flatMap(([name, help, value]) => [`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name} ${value}`]).join('\n')}\n`
  }
}
