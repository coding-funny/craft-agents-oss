import { randomUUID } from 'node:crypto'
import type { Database } from 'bun:sqlite'
import type { CommerceDatabase } from '../storage/database.ts'

export class OutboxRepository {
  readonly #db: Database
  constructor(store: CommerceDatabase) { this.#db = store.database }

  append(input: {
    tenantId: string; shopId: string; aggregateType: string; aggregateId: string; eventType: string
    idempotencyKey: string; payload: unknown; now: string
  }): string {
    const eventId = `event_${randomUUID()}`
    this.#db.query(`INSERT INTO commerce_outbox (
      event_id, tenant_id, shop_id, aggregate_type, aggregate_id, event_type, idempotency_key,
      payload_json, status, available_at, created_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'PENDING', ?9, ?9)
    ON CONFLICT(idempotency_key) DO NOTHING`).run(
      eventId, input.tenantId, input.shopId, input.aggregateType, input.aggregateId, input.eventType,
      input.idempotencyKey, JSON.stringify(input.payload), input.now,
    )
    return eventId
  }

  claim(input: { workerId: string; now: string; leaseMs: number }): {
    eventId: string; eventType: string; idempotencyKey: string; payload: unknown
  } | undefined {
    return this.#db.transaction(() => {
      this.#db.query("UPDATE commerce_outbox SET status = 'PENDING', lease_owner = NULL, lease_until = NULL WHERE status = 'LEASED' AND lease_until <= ?1")
        .run(input.now)
      const row = this.#db.query<{
        event_id: string; event_type: string; idempotency_key: string; payload_json: string
      }, [string]>("SELECT event_id, event_type, idempotency_key, payload_json FROM commerce_outbox WHERE status = 'PENDING' AND available_at <= ?1 ORDER BY created_at, event_id LIMIT 1").get(input.now)
      if (!row) return undefined
      const until = new Date(Date.parse(input.now) + input.leaseMs).toISOString()
      const changed = this.#db.query("UPDATE commerce_outbox SET status = 'LEASED', lease_owner = ?1, lease_until = ?2, attempts = attempts + 1 WHERE event_id = ?3 AND status = 'PENDING'")
        .run(input.workerId, until, row.event_id)
      if (changed.changes !== 1) return undefined
      return { eventId: row.event_id, eventType: row.event_type, idempotencyKey: row.idempotency_key, payload: JSON.parse(row.payload_json) }
    }).immediate()
  }

  markPublished(input: { eventId: string; workerId: string; now: string }): boolean {
    return this.#db.query(`UPDATE commerce_outbox SET status = 'PUBLISHED', published_at = ?1,
      lease_owner = NULL, lease_until = NULL WHERE event_id = ?2 AND status = 'LEASED'
      AND lease_owner = ?3 AND lease_until > ?1`).run(input.now, input.eventId, input.workerId).changes === 1
  }
}
