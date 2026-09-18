import type { Database } from 'bun:sqlite'
import { CommerceError } from '../domain/errors.ts'
import { contentDigest } from '../approvals/repository.ts'
import type { AuthenticatedPrincipal } from '../auth/contracts.ts'

export class RequestIdempotency {
  readonly #db: Database

  constructor(database: Database) { this.#db = database }

  async execute<T>(input: {
    principal: AuthenticatedPrincipal; operation: string; key: string; payload: unknown; now: string; work: () => Promise<T>
  }): Promise<{ value: T; replayed: boolean }> {
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(input.key)) throw new CommerceError('INVALID_ARGUMENT', 'A valid Idempotency-Key is required')
    const payloadHash = contentDigest(input.payload)
    const read = () => this.#db.query<{ payload_hash: string; response_json: string }, [string, string, string, string]>(`
        SELECT payload_hash, response_json FROM commerce_request_idempotency
        WHERE tenant_id = ?1 AND actor_id = ?2 AND operation = ?3 AND request_key = ?4
      `).get(input.principal.tenantId, input.principal.actorId, input.operation, input.key)
    const row = read()
    if (row) {
      if (row.payload_hash !== payloadHash) throw new CommerceError('INVALID_ARGUMENT', 'Idempotency key was reused with a different payload')
      return { value: JSON.parse(row.response_json) as T, replayed: true }
    }
    const value = await input.work()
    try {
      this.#db.query(`INSERT INTO commerce_request_idempotency (
        tenant_id, actor_id, operation, request_key, payload_hash, response_json, created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`).run(
        input.principal.tenantId, input.principal.actorId, input.operation, input.key,
        payloadHash, JSON.stringify(value), input.now,
      )
      return { value, replayed: false }
    } catch (error) {
      const concurrent = read()
      if (!concurrent || concurrent.payload_hash !== payloadHash) throw error
      return { value: JSON.parse(concurrent.response_json) as T, replayed: true }
    }
  }
}
