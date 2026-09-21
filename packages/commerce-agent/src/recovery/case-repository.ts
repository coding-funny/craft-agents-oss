import { createHash } from 'node:crypto'
import type { Database } from 'bun:sqlite'
import { CommerceError } from '../domain/errors.ts'
import type { DiagnosisCaseName } from '../diagnosis/workflow.ts'
import type { CommerceDatabase } from '../storage/database.ts'

export const CASE_RUN_STATES = [
  'CREATED',
  'DIAGNOSING',
  'REPORT_READY',
  'PROPOSAL_PENDING',
  'APPROVED',
  'EXECUTING',
  'SUCCEEDED',
  'FAILED',
  'UNKNOWN',
  'TIMED_OUT',
] as const

export type CaseRunState = (typeof CASE_RUN_STATES)[number]

export type CaseRun = {
  sessionId: string
  caseName: DiagnosisCaseName
  state: CaseRunState
  reportId?: string
  proposalId?: string
  traceId: string
  parentTraceId?: string
  runCount: number
  lastError?: string
  createdAt: string
  updatedAt: string
}

type CaseRunRow = {
  session_id: string
  case_name: DiagnosisCaseName
  state: CaseRunState
  report_id: string | null
  proposal_id: string | null
  trace_id: string
  parent_trace_id: string | null
  run_count: number
  last_error: string | null
  created_at: string
  updated_at: string
}

function fromRow(row: CaseRunRow): CaseRun {
  return {
    sessionId: row.session_id,
    caseName: row.case_name,
    state: row.state,
    reportId: row.report_id ?? undefined,
    proposalId: row.proposal_id ?? undefined,
    traceId: row.trace_id,
    parentTraceId: row.parent_trace_id ?? undefined,
    runCount: row.run_count,
    lastError: row.last_error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function recoveryTraceId(sessionId: string, runCount: number): string {
  const digest = createHash('sha256').update(`${sessionId}:${runCount}`).digest('hex').slice(0, 24)
  return `trace-recovery-${digest}`
}

export class CaseRepository {
  readonly #db: Database

  constructor(store: CommerceDatabase) {
    this.#db = store.database
  }

  get(sessionId: string): CaseRun | undefined {
    const row = this.#db.query<CaseRunRow, [string]>('SELECT * FROM case_runs WHERE session_id = ?1').get(sessionId)
    return row ? fromRow(row) : undefined
  }

  getOrThrow(sessionId: string): CaseRun {
    const run = this.get(sessionId)
    if (!run) throw new CommerceError('NOT_FOUND', `Case session not found: ${sessionId}`)
    return run
  }

  createOrGet(input: { sessionId: string; caseName: DiagnosisCaseName; now: string }): CaseRun {
    const existing = this.get(input.sessionId)
    if (existing) {
      if (existing.caseName !== input.caseName) {
        throw new CommerceError('INVALID_ARGUMENT', `Session ${input.sessionId} belongs to ${existing.caseName}`)
      }
      return existing
    }
    const traceId = recoveryTraceId(input.sessionId, 0)
    this.#db.transaction(() => {
      this.#db.query(`
        INSERT INTO case_runs (
          session_id, case_name, state, trace_id, run_count, created_at, updated_at
        ) VALUES (?1, ?2, 'CREATED', ?3, 0, ?4, ?4)
      `).run(input.sessionId, input.caseName, traceId, input.now)
      this.event({ sessionId: input.sessionId, traceId, eventType: 'CASE_CREATED', state: 'CREATED', createdAt: input.now })
    }).immediate()
    return this.getOrThrow(input.sessionId)
  }

  beginAttempt(sessionId: string, now: string): CaseRun {
    const current = this.getOrThrow(sessionId)
    const runCount = current.runCount + 1
    const traceId = recoveryTraceId(sessionId, runCount)
    this.#db.transaction(() => {
      this.#db.query(`
        UPDATE case_runs
        SET trace_id = ?1, parent_trace_id = ?2, run_count = ?3, updated_at = ?4, last_error = NULL
        WHERE session_id = ?5
      `).run(traceId, current.traceId, runCount, now, sessionId)
      this.event({
        sessionId, traceId, parentTraceId: current.traceId, eventType: 'RUN_ATTEMPT_STARTED',
        state: current.state, details: { runCount }, createdAt: now,
      })
    }).immediate()
    return this.getOrThrow(sessionId)
  }

  update(input: {
    sessionId: string
    state: CaseRunState
    reportId?: string
    proposalId?: string
    lastError?: string
    eventType: string
    details?: unknown
    now: string
  }): CaseRun {
    const current = this.getOrThrow(input.sessionId)
    this.#db.transaction(() => {
      this.#db.query(`
        UPDATE case_runs SET state = ?1, report_id = COALESCE(?2, report_id),
          proposal_id = COALESCE(?3, proposal_id), last_error = ?4, updated_at = ?5
        WHERE session_id = ?6
      `).run(
        input.state,
        input.reportId ?? null,
        input.proposalId ?? null,
        input.lastError ?? null,
        input.now,
        input.sessionId,
      )
      this.event({
        sessionId: input.sessionId,
        traceId: current.traceId,
        parentTraceId: current.parentTraceId,
        eventType: input.eventType,
        state: input.state,
        details: input.details,
        createdAt: input.now,
      })
    }).immediate()
    return this.getOrThrow(input.sessionId)
  }

  event(input: {
    sessionId: string
    traceId: string
    parentTraceId?: string
    eventType: string
    state: CaseRunState
    details?: unknown
    createdAt: string
  }): void {
    this.#db.query(`
      INSERT INTO case_events (
        session_id, trace_id, parent_trace_id, event_type, state, details_json, created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
    `).run(
      input.sessionId,
      input.traceId,
      input.parentTraceId ?? null,
      input.eventType,
      input.state,
      JSON.stringify(input.details ?? {}),
      input.createdAt,
    )
  }

  listEvents(sessionId: string): Array<Record<string, unknown>> {
    return this.#db.query<Record<string, unknown>, [string]>(
      'SELECT * FROM case_events WHERE session_id = ?1 ORDER BY event_id',
    ).all(sessionId)
  }
}
