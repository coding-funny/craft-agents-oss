import { createHash, randomUUID } from 'node:crypto'
import { Database } from 'bun:sqlite'
import type { ActionOutcome, ActionRequest } from '../../src/execution/action-executor.ts'

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export type PlatformMode = 'NORMAL' | 'APPLY_THEN_ERROR'

export class TestCommercePlatform {
  readonly database: Database
  readonly server: ReturnType<typeof Bun.serve>
  mode: PlatformMode = 'NORMAL'
  visibilityMisses = 0
  readonly #lookups = new Map<string, number>()
  posts = 0

  constructor(path: string) {
    this.database = new Database(path)
    this.database.exec(`
      CREATE TABLE targets (target_id TEXT PRIMARY KEY, version INTEGER NOT NULL, value_json TEXT NOT NULL);
      CREATE TABLE operations (
        operation_id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, idempotency_key TEXT NOT NULL UNIQUE,
        payload_hash TEXT NOT NULL, before_json TEXT NOT NULL, after_json TEXT NOT NULL
      );
      INSERT INTO targets VALUES ('CAMPAIGN-C', 1, '{"budgetMinor":50000}');
    `)
    this.server = Bun.serve({ port: 0, fetch: request => this.#handle(request) })
  }

  get baseUrl(): string { return `http://127.0.0.1:${this.server.port}` }

  effectCount(): number {
    return this.database.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM operations').get()!.count
  }

  close(): void { this.server.stop(true); this.database.close() }

  async #handle(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === 'POST' && url.pathname === '/operations') return this.#write(await request.json() as ActionRequest)
    if (request.method === 'GET' && url.pathname.startsWith('/operations/')) return this.#lookup(decodeURIComponent(url.pathname.slice('/operations/'.length)))
    return Response.json({ error: 'not-found' }, { status: 404 })
  }

  #write(request: ActionRequest): Response {
    this.posts += 1
    const payloadHash = digest(request)
    const existing = this.database.query<{
      operation_id: string; payload_hash: string; before_json: string; after_json: string
    }, [string]>('SELECT * FROM operations WHERE idempotency_key = ?1').get(request.idempotencyKey)
    if (existing) {
      if (existing.payload_hash !== payloadHash) return Response.json({ status: 'REJECTED', reason: 'IDEMPOTENCY_PAYLOAD_MISMATCH' }, { status: 409 })
      return Response.json({ status: 'APPLIED', operationId: existing.operation_id, before: JSON.parse(existing.before_json), after: JSON.parse(existing.after_json) })
    }
    const target = this.database.query<{ version: number; value_json: string }, [string]>(
      'SELECT version, value_json FROM targets WHERE target_id = ?1',
    ).get(request.targetId)
    if (!target || target.version !== request.expectedVersion) {
      return Response.json({ status: 'REJECTED', reason: 'EXPECTED_VERSION_MISMATCH' }, { status: 409 })
    }
    const before = { ...JSON.parse(target.value_json), version: target.version }
    const nextValue = { ...JSON.parse(target.value_json), ...request.parameters }
    const changed = this.database.query('UPDATE targets SET version = version + 1, value_json = ?1 WHERE target_id = ?2 AND version = ?3')
      .run(JSON.stringify(nextValue), request.targetId, request.expectedVersion)
    if (changed.changes !== 1) return Response.json({ status: 'REJECTED', reason: 'EXPECTED_VERSION_RACE' }, { status: 409 })
    const after = { ...nextValue, version: target.version + 1 }
    const operationId = `operation_${randomUUID()}`
    this.database.query('INSERT INTO operations VALUES (?1, ?2, ?3, ?4, ?5, ?6)').run(
      operationId, request.requestId, request.idempotencyKey, payloadHash, JSON.stringify(before), JSON.stringify(after),
    )
    if (this.mode === 'APPLY_THEN_ERROR') return Response.json({ error: 'response-lost-after-commit' }, { status: 503 })
    return Response.json({ status: 'APPLIED', operationId, before, after } satisfies ActionOutcome)
  }

  #lookup(requestId: string): Response {
    const count = (this.#lookups.get(requestId) ?? 0) + 1
    this.#lookups.set(requestId, count)
    if (count <= this.visibilityMisses) return Response.json({ status: 'NOT_FOUND' }, { status: 404 })
    const row = this.database.query<{ operation_id: string; before_json: string; after_json: string }, [string]>(
      'SELECT * FROM operations WHERE request_id = ?1',
    ).get(requestId)
    if (!row) return Response.json({ status: 'NOT_FOUND' }, { status: 404 })
    return Response.json({
      status: 'APPLIED', operationId: row.operation_id,
      before: JSON.parse(row.before_json), after: JSON.parse(row.after_json),
    } satisfies ActionOutcome)
  }
}
