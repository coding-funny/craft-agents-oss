import { randomUUID } from 'node:crypto'
import type { Database } from 'bun:sqlite'
import type { BudgetConfig, InvestigationResult, RunManifest, RunStatus } from '../contracts/runtime.ts'
import type { ClarificationRequest, InvestigationTask } from '../contracts/task.ts'
import { CommerceError } from '../domain/errors.ts'
import { assertRunTransition } from '../agent/state-machine.ts'
import type { CommerceDatabase } from './database.ts'

export type RunRecord = {
  runId: string
  taskId: string
  taskVersion: number
  attempt: number
  parentRunId?: string
  traceId: string
  status: RunStatus
  reportId?: string
  clarification?: ClarificationRequest
  error?: InvestigationResult['error']
  completionReason?: string
  manifest?: RunManifest
  createdAt: string
  updatedAt: string
}

export type RunEvent = {
  eventId?: string
  runId: string
  type: string
  payload?: unknown
  createdAt: string
}

type TaskRow = {
  task_id: string; version: number; tenant_id: string; requested_by: string; input_json: string
  resolved_scope_json: string | null; as_of: string; fixture_digest: string; created_at: string
}
type RunRow = {
  run_id: string; task_id: string; attempt: number; parent_run_id: string | null; trace_id: string
  status: RunStatus; report_id: string | null; clarification_json: string | null; error_json: string | null
  completion_reason: string | null; manifest_json: string | null; created_at: string; updated_at: string
  task_version?: number | null
}

function taskFromRow(row: TaskRow): InvestigationTask {
  return {
    schemaVersion: 1,
    taskId: row.task_id,
    version: row.version,
    tenantId: row.tenant_id,
    requestedBy: row.requested_by,
    input: JSON.parse(row.input_json),
    resolvedScope: row.resolved_scope_json ? JSON.parse(row.resolved_scope_json) : undefined,
    asOf: row.as_of,
    fixtureDigest: row.fixture_digest,
    createdAt: row.created_at,
  }
}

function runFromRow(row: RunRow): RunRecord {
  return {
    runId: row.run_id,
    taskId: row.task_id,
    taskVersion: row.task_version ?? 1,
    attempt: row.attempt,
    parentRunId: row.parent_run_id ?? undefined,
    traceId: row.trace_id,
    status: row.status,
    reportId: row.report_id ?? undefined,
    clarification: row.clarification_json ? JSON.parse(row.clarification_json) : undefined,
    error: row.error_json ? JSON.parse(row.error_json) : undefined,
    completionReason: row.completion_reason ?? undefined,
    manifest: row.manifest_json ? JSON.parse(row.manifest_json) : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class InvestigationRepository {
  readonly #db: Database

  constructor(store: CommerceDatabase) {
    this.#db = store.database
  }

  async createTask(task: InvestigationTask, budget: BudgetConfig, onPersisted?: () => void): Promise<void> {
    const existing = this.#db.query<TaskRow, [string]>('SELECT * FROM investigation_tasks WHERE task_id = ?1').get(task.taskId)
    const transaction = this.#db.transaction(() => {
      if (!existing) {
        if (task.version !== 1) throw new CommerceError('INVALID_ARGUMENT', 'A new task must start at version 1')
        this.#db.query(`INSERT INTO investigation_tasks (
          task_id, version, tenant_id, requested_by, input_json, resolved_scope_json,
          as_of, fixture_digest, budget_json, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)`).run(
          task.taskId, task.version, task.tenantId, task.requestedBy, JSON.stringify(task.input),
          task.resolvedScope ? JSON.stringify(task.resolvedScope) : null, task.asOf, task.fixtureDigest,
          JSON.stringify(budget), task.createdAt,
        )
        this.#insertTaskVersion(task, budget)
        onPersisted?.()
        return
      }
      if (existing.version === task.version) {
        const persisted = taskFromRow(existing)
        if (JSON.stringify(persisted) !== JSON.stringify(task)) {
          throw new CommerceError('INVALID_ARGUMENT', 'Task version already exists with different content')
        }
        onPersisted?.()
        return
      }
      if (task.version !== existing.version + 1) throw new CommerceError('INVALID_ARGUMENT', 'Task version must advance by exactly one')
      const updated = this.#db.query(`UPDATE investigation_tasks SET
        version = ?1, requested_by = ?2, input_json = ?3, resolved_scope_json = ?4,
        as_of = ?5, fixture_digest = ?6, budget_json = ?7, updated_at = ?8
        WHERE task_id = ?9 AND version = ?10`).run(
        task.version, task.requestedBy, JSON.stringify(task.input), task.resolvedScope ? JSON.stringify(task.resolvedScope) : null,
        task.asOf, task.fixtureDigest, JSON.stringify(budget), task.createdAt, task.taskId, existing.version,
      )
      if (updated.changes !== 1) throw new CommerceError('INVALID_ARGUMENT', 'Task version update lost a concurrency race')
      this.#insertTaskVersion(task, budget)
      onPersisted?.()
    })
    try {
      transaction.immediate()
    } catch (error) {
      if (error instanceof CommerceError) throw error
      throw new CommerceError('STORAGE_UNAVAILABLE', 'Failed to persist investigation task', { cause: String(error) })
    }
  }

  async getTask(taskId: string): Promise<InvestigationTask> {
    const row = this.#db.query<TaskRow, [string]>('SELECT * FROM investigation_tasks WHERE task_id = ?1').get(taskId)
    if (!row) throw new CommerceError('NOT_FOUND', `Investigation task not found: ${taskId}`)
    return taskFromRow(row)
  }

  async createRun(taskId: string, options: { parentRunId?: string; now: string }): Promise<RunRecord> {
    const task = await this.getTask(taskId)
    const count = this.#db.query<{ count: number }, [string]>('SELECT COUNT(*) AS count FROM investigation_runs WHERE task_id = ?1').get(taskId)?.count ?? 0
    const runId = `run_${randomUUID()}`
    const traceId = `trace-${randomUUID()}`
    const attempt = count + 1
    const transaction = this.#db.transaction(() => {
      this.#db.query(`INSERT INTO investigation_runs (
        run_id, task_id, attempt, parent_run_id, trace_id, status, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, 'QUEUED', ?6, ?6)`).run(
        runId, taskId, attempt, options.parentRunId ?? null, traceId, options.now,
      )
      this.#db.query(`INSERT INTO investigation_run_versions (run_id, task_id, task_version)
        VALUES (?1, ?2, ?3)`).run(runId, taskId, task.version)
      this.#insertEvent({ runId, type: 'RUN_CREATED', payload: { attempt, parentRunId: options.parentRunId }, createdAt: options.now })
    })
    try { transaction.immediate() } catch (error) {
      throw new CommerceError('STORAGE_UNAVAILABLE', 'Failed to create investigation run', { cause: String(error) })
    }
    return this.getRunSync(runId)
  }

  async getRun(runId: string): Promise<RunRecord> { return this.getRunSync(runId) }

  async getLatestRun(taskId: string): Promise<RunRecord> {
    const row = this.#db.query<RunRow, [string]>(`SELECT r.*,
      (SELECT task_version FROM investigation_run_versions v WHERE v.run_id = r.run_id) AS task_version
      FROM investigation_runs r WHERE r.task_id = ?1 ORDER BY r.attempt DESC LIMIT 1`).get(taskId)
    if (!row) throw new CommerceError('NOT_FOUND', `No run exists for task: ${taskId}`)
    return runFromRow(row)
  }

  getRunSync(runId: string): RunRecord {
    const row = this.#db.query<RunRow, [string]>(`SELECT r.*,
      (SELECT task_version FROM investigation_run_versions v WHERE v.run_id = r.run_id) AS task_version
      FROM investigation_runs r WHERE r.run_id = ?1`).get(runId)
    if (!row) throw new CommerceError('NOT_FOUND', `Investigation run not found: ${runId}`)
    return runFromRow(row)
  }

  async transition(input: {
    runId: string; expected: RunStatus; status: RunStatus; now: string; eventType: string
    reportId?: string; clarification?: ClarificationRequest; error?: InvestigationResult['error']
    completionReason?: string; manifest?: RunManifest; payload?: unknown
  }): Promise<RunRecord> {
    assertRunTransition(input.expected, input.status)
    const transaction = this.#db.transaction(() => {
      const current = this.getRunSync(input.runId)
      if (current.status !== input.expected) throw new CommerceError('INVALID_ARGUMENT', `Run state changed: ${current.status}`)
      const updated = this.#db.query(`UPDATE investigation_runs SET
        status = ?1, report_id = COALESCE(?2, report_id), clarification_json = COALESCE(?3, clarification_json),
        error_json = COALESCE(?4, error_json), completion_reason = COALESCE(?5, completion_reason),
        manifest_json = COALESCE(?6, manifest_json), updated_at = ?7
        WHERE run_id = ?8 AND status = ?9`).run(
        input.status, input.reportId ?? null, input.clarification ? JSON.stringify(input.clarification) : null,
        input.error ? JSON.stringify(input.error) : null, input.completionReason ?? null,
        input.manifest ? JSON.stringify(input.manifest) : null, input.now, input.runId, input.expected,
      )
      if (updated.changes !== 1) throw new CommerceError('INVALID_ARGUMENT', 'Run transition lost a concurrency race')
      this.#insertEvent({ runId: input.runId, type: input.eventType, payload: input.payload, createdAt: input.now })
    })
    try { transaction.immediate() } catch (error) {
      if (error instanceof CommerceError) throw error
      throw new CommerceError('STORAGE_UNAVAILABLE', 'Failed to transition investigation run', { cause: String(error) })
    }
    return this.getRunSync(input.runId)
  }

  async appendEvent(event: RunEvent): Promise<void> { this.#insertEvent(event) }

  async checkpoint(input: { runId: string; state: unknown; budget: unknown; now: string }): Promise<void> {
    const number = (this.#db.query<{ count: number }, [string]>(
      'SELECT COUNT(*) AS count FROM investigation_checkpoints WHERE run_id = ?1',
    ).get(input.runId)?.count ?? 0) + 1
    this.#db.query(`INSERT INTO investigation_checkpoints (
      run_id, checkpoint_no, state_json, budget_json, created_at
    ) VALUES (?1, ?2, ?3, ?4, ?5)`).run(input.runId, number, JSON.stringify(input.state), JSON.stringify(input.budget), input.now)
  }

  listEvents(runId: string): Array<{ eventId: string; sequence: number; type: string; payload: unknown; createdAt: string }> {
    return this.#db.query<{ event_id: string; sequence: number; event_type: string; payload_json: string; created_at: string }, [string]>(
      'SELECT event_id, sequence, event_type, payload_json, created_at FROM investigation_events WHERE run_id = ?1 ORDER BY sequence',
    ).all(runId).map(row => ({ eventId: row.event_id, sequence: row.sequence, type: row.event_type, payload: JSON.parse(row.payload_json), createdAt: row.created_at }))
  }

  #insertEvent(event: RunEvent): void {
    const sequence = (this.#db.query<{ max: number | null }, [string]>(
      'SELECT MAX(sequence) AS max FROM investigation_events WHERE run_id = ?1',
    ).get(event.runId)?.max ?? 0) + 1
    this.#db.query(`INSERT INTO investigation_events (
      event_id, run_id, sequence, event_type, payload_json, created_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`).run(
      event.eventId ?? `event_${randomUUID()}`, event.runId, sequence, event.type,
      JSON.stringify(event.payload ?? {}), event.createdAt,
    )
  }

  #insertTaskVersion(task: InvestigationTask, budget: BudgetConfig): void {
    this.#db.query(`INSERT INTO investigation_task_versions (
      task_id, version, input_json, resolved_scope_json, as_of, fixture_digest, budget_json, created_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`).run(
      task.taskId, task.version, JSON.stringify(task.input), task.resolvedScope ? JSON.stringify(task.resolvedScope) : null,
      task.asOf, task.fixtureDigest, JSON.stringify(budget), task.createdAt,
    )
  }
}
