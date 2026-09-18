import { randomUUID } from 'node:crypto'
import type { Database } from 'bun:sqlite'
import type { CommerceDatabase } from '../storage/database.ts'
import type { DurableJob, JobKind, JobLease, JobStatus, LeaseToken } from './contracts.ts'

type JobRow = {
  job_id: string; kind: JobKind; tenant_id: string; shop_id: string; business_key: string
  payload_json: string; priority: number; status: JobStatus; available_at: string; attempts: number
  max_attempts: number; lease_owner: string | null; lease_until: string | null; lease_epoch: number
  cancel_requested_at: string | null; last_error_json: string | null; created_at: string; updated_at: string
}

function fromRow<T>(row: JobRow): DurableJob<T> {
  return {
    jobId: row.job_id, kind: row.kind, tenantId: row.tenant_id, shopId: row.shop_id,
    businessKey: row.business_key, payload: JSON.parse(row.payload_json) as T, priority: row.priority,
    status: row.status, availableAt: row.available_at, attempts: row.attempts, maxAttempts: row.max_attempts,
    leaseOwner: row.lease_owner ?? undefined, leaseUntil: row.lease_until ?? undefined,
    leaseEpoch: row.lease_epoch, cancelRequestedAt: row.cancel_requested_at ?? undefined,
    lastError: row.last_error_json ? JSON.parse(row.last_error_json) : undefined,
    createdAt: row.created_at, updatedAt: row.updated_at,
  }
}

export class DurableJobRepository {
  readonly #db: Database

  constructor(store: CommerceDatabase) { this.#db = store.database }

  transaction<T>(operation: () => T): T { return this.#db.transaction(operation).immediate() }

  enqueue<T>(input: {
    kind: JobKind; tenantId: string; shopId: string; businessKey: string; payload: T
    now: string; availableAt?: string; priority?: number; maxAttempts?: number; jobId?: string
  }): DurableJob<T> {
    const jobId = input.jobId ?? `job_${randomUUID()}`
    this.#db.query(`INSERT INTO commerce_jobs (
      job_id, kind, tenant_id, shop_id, business_key, payload_json, priority, status,
      available_at, max_attempts, created_at, updated_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'READY', ?8, ?9, ?10, ?10)
    ON CONFLICT(kind, tenant_id, business_key) DO NOTHING`).run(
      jobId, input.kind, input.tenantId, input.shopId, input.businessKey, JSON.stringify(input.payload),
      input.priority ?? 0, input.availableAt ?? input.now, input.maxAttempts ?? 5, input.now,
    )
    return this.findByBusinessKey<T>(input.kind, input.tenantId, input.businessKey)!
  }

  get<T = unknown>(jobId: string): DurableJob<T> | undefined {
    const row = this.#db.query<JobRow, [string]>('SELECT * FROM commerce_jobs WHERE job_id = ?1').get(jobId)
    return row ? fromRow<T>(row) : undefined
  }

  findByBusinessKey<T>(kind: JobKind, tenantId: string, businessKey: string): DurableJob<T> | undefined {
    const row = this.#db.query<JobRow, [JobKind, string, string]>(
      'SELECT * FROM commerce_jobs WHERE kind = ?1 AND tenant_id = ?2 AND business_key = ?3',
    ).get(kind, tenantId, businessKey)
    return row ? fromRow<T>(row) : undefined
  }

  claim(input: {
    workerId: string; kinds: JobKind[]; now: string; leaseMs: number; maxActivePerTenant?: number
  }): JobLease | undefined {
    if (input.kinds.length === 0) return undefined
    return this.transaction(() => {
      this.recoverExpired(input.now)
      const placeholders = input.kinds.map((_, index) => `?${index + 3}`).join(', ')
      const args = [input.now, input.maxActivePerTenant ?? 2, ...input.kinds] as [string, number, ...JobKind[]]
      const row = this.#db.query<JobRow, typeof args>(`SELECT j.* FROM commerce_jobs j
        WHERE j.status IN ('READY', 'RETRY_WAIT') AND j.available_at <= ?1
          AND j.cancel_requested_at IS NULL AND j.kind IN (${placeholders})
          AND (SELECT COUNT(*) FROM commerce_jobs active
            WHERE active.tenant_id = j.tenant_id AND active.status = 'LEASED'
              AND active.lease_until > ?1) < ?2
        ORDER BY j.priority DESC, j.available_at, j.created_at, j.job_id LIMIT 1`).get(...args)
      if (!row) return undefined
      const leaseUntil = new Date(Date.parse(input.now) + input.leaseMs).toISOString()
      const changed = this.#db.query(`UPDATE commerce_jobs SET status = 'LEASED', lease_owner = ?1,
        lease_until = ?2, lease_epoch = lease_epoch + 1, attempts = attempts + 1, updated_at = ?3
        WHERE job_id = ?4 AND status IN ('READY', 'RETRY_WAIT')`).run(
        input.workerId, leaseUntil, input.now, row.job_id,
      )
      if (changed.changes !== 1) return undefined
      return this.get(row.job_id) as JobLease
    })
  }

  recoverExpired(now: string): number {
    const result = this.#db.query(`UPDATE commerce_jobs SET
      status = CASE WHEN attempts >= max_attempts THEN 'MANUAL_REVIEW' ELSE 'RETRY_WAIT' END,
      available_at = ?1, lease_owner = NULL, lease_until = NULL,
      last_error_json = json_object('code', 'LEASE_EXPIRED'), updated_at = ?1
      WHERE status = 'LEASED' AND lease_until <= ?1`).run(now)
    return result.changes
  }

  heartbeat(token: LeaseToken, now: string, leaseMs: number): boolean {
    const until = new Date(Date.parse(now) + leaseMs).toISOString()
    return this.#db.query(`UPDATE commerce_jobs SET lease_until = ?1, updated_at = ?2
      WHERE job_id = ?3 AND lease_owner = ?4 AND lease_epoch = ?5
        AND status = 'LEASED' AND lease_until > ?2`).run(
      until, now, token.jobId, token.owner, token.epoch,
    ).changes === 1
  }

  checkpoint(token: LeaseToken, key: string, state: unknown, now: string): boolean {
    return this.transaction(() => {
      if (!this.hasLease(token, now)) return false
      this.#db.query(`INSERT INTO commerce_job_checkpoints (
        job_id, checkpoint_key, lease_epoch, state_json, created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5)
      ON CONFLICT(job_id, checkpoint_key) DO UPDATE SET
        lease_epoch = excluded.lease_epoch, state_json = excluded.state_json, created_at = excluded.created_at`).run(
        token.jobId, key, token.epoch, JSON.stringify(state), now,
      )
      return true
    })
  }

  succeed(token: LeaseToken, now: string): boolean {
    return this.#finish(token, now, 'SUCCEEDED')
  }

  fail(token: LeaseToken, now: string, error: unknown): boolean {
    return this.#finish(token, now, 'FAILED', error)
  }

  manualReview(token: LeaseToken, now: string, error: unknown): boolean {
    return this.#finish(token, now, 'MANUAL_REVIEW', error)
  }

  waitingInput(token: LeaseToken, now: string): boolean {
    return this.#finish(token, now, 'WAITING_INPUT')
  }

  cancelLeased(token: LeaseToken, now: string): boolean {
    const result = this.#db.query(`UPDATE commerce_jobs SET status = 'CANCELLED',
      cancel_requested_at = COALESCE(cancel_requested_at, ?1), lease_owner = NULL, lease_until = NULL,
      updated_at = ?1 WHERE job_id = ?2 AND lease_owner = ?3 AND lease_epoch = ?4
        AND status = 'LEASED' AND lease_until > ?1`).run(now, token.jobId, token.owner, token.epoch)
    return result.changes === 1
  }

  retry(token: LeaseToken, now: string, availableAt: string, error: unknown): boolean {
    const result = this.#db.query(`UPDATE commerce_jobs SET status = CASE
      WHEN attempts >= max_attempts THEN 'MANUAL_REVIEW' ELSE 'RETRY_WAIT' END,
      available_at = ?1, lease_owner = NULL, lease_until = NULL, last_error_json = ?2, updated_at = ?3
      WHERE job_id = ?4 AND lease_owner = ?5 AND lease_epoch = ?6
        AND status = 'LEASED' AND lease_until > ?3`).run(
      availableAt, JSON.stringify(error), now, token.jobId, token.owner, token.epoch,
    )
    return result.changes === 1
  }

  requestCancel(jobId: string, now: string): DurableJob | undefined {
    return this.transaction(() => {
      const job = this.get(jobId)
      if (!job) return undefined
      if (job.status === 'READY' || job.status === 'RETRY_WAIT') {
        this.#db.query("UPDATE commerce_jobs SET status = 'CANCELLED', cancel_requested_at = ?1, updated_at = ?1 WHERE job_id = ?2").run(now, jobId)
      } else if (job.status === 'LEASED') {
        this.#db.query('UPDATE commerce_jobs SET cancel_requested_at = ?1, updated_at = ?1 WHERE job_id = ?2').run(now, jobId)
      }
      return this.get(jobId)
    })
  }

  hasLease(token: LeaseToken, now: string): boolean {
    return Boolean(this.#db.query<{ ok: number }, [string, string, number, string]>(`SELECT 1 AS ok FROM commerce_jobs
      WHERE job_id = ?1 AND lease_owner = ?2 AND lease_epoch = ?3
        AND status = 'LEASED' AND lease_until > ?4`).get(token.jobId, token.owner, token.epoch, now))
  }

  isCancellationRequested(jobId: string): boolean {
    return Boolean(this.#db.query<{ cancel_requested_at: string | null }, [string]>(
      'SELECT cancel_requested_at FROM commerce_jobs WHERE job_id = ?1',
    ).get(jobId)?.cancel_requested_at)
  }

  #finish(token: LeaseToken, now: string, status: Extract<JobStatus, 'SUCCEEDED' | 'FAILED' | 'WAITING_INPUT' | 'MANUAL_REVIEW'>, error?: unknown): boolean {
    const result = this.#db.query(`UPDATE commerce_jobs SET status = ?1, lease_owner = NULL,
      lease_until = NULL, last_error_json = ?2, updated_at = ?3
      WHERE job_id = ?4 AND lease_owner = ?5 AND lease_epoch = ?6
        AND status = 'LEASED' AND lease_until > ?3`).run(
      status, error === undefined ? null : JSON.stringify(error), now, token.jobId, token.owner, token.epoch,
    )
    return result.changes === 1
  }
}
