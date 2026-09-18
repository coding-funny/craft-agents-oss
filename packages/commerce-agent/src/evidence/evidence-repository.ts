import { createHash } from 'node:crypto'
import type { EvidenceRecord, EvidenceRef } from '../domain/contracts.ts'
import { CommerceError } from '../domain/errors.ts'

const VOLATILE_QUERY_KEYS = new Set(['traceId', 'runId', 'caseId'])

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    )
  }
  return value
}

function stableQuery(query: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(query).filter(([key]) => !VOLATILE_QUERY_KEYS.has(key)))
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex')
}

export type CaptureEvidenceInput = {
  tool: string
  source: string
  asOf: string
  traceId: string
  query: Record<string, unknown>
  recordRefs: string[]
  content: unknown
  summary: string
}

export type EvidenceStore = {
  saveEvidence(record: EvidenceRecord): void
  getEvidence(evidenceId: string): EvidenceRecord | undefined
}

export class EvidenceRepository {
  readonly #records = new Map<string, EvidenceRecord>()
  readonly #store?: EvidenceStore

  constructor(store?: EvidenceStore) {
    this.#store = store
  }

  capture(input: CaptureEvidenceInput): EvidenceRef {
    const stablePayload = {
      tool: input.tool,
      source: input.source,
      query: stableQuery(input.query),
      recordRefs: [...input.recordRefs].sort(),
      content: input.content,
    }
    const evidenceId = `ev_${digest(stablePayload).slice(0, 24)}`

    if (!this.#records.has(evidenceId)) {
      const record: EvidenceRecord = {
        evidenceId,
        tool: input.tool,
        source: input.source,
        asOf: input.asOf,
        query: canonicalize(input.query) as Record<string, unknown>,
        recordRefs: [...input.recordRefs].sort(),
        content: canonicalize(input.content),
        summary: input.summary,
        createdAt: input.asOf,
      }
      this.#records.set(evidenceId, record)
      this.#store?.saveEvidence(record)
    }

    return {
      evidenceId,
      source: input.source,
      locator: input.recordRefs.length > 0 ? [...input.recordRefs].sort().join(',') : 'empty-result',
      traceId: input.traceId,
    }
  }

  get(evidenceId: string): EvidenceRecord | undefined {
    const inMemory = this.#records.get(evidenceId)
    if (inMemory) return inMemory
    const persisted = this.#store?.getEvidence(evidenceId)
    if (persisted) this.#records.set(evidenceId, persisted)
    return persisted
  }

  getOrThrow(evidenceId: string): EvidenceRecord {
    const record = this.get(evidenceId)
    if (!record) throw new CommerceError('NOT_FOUND', `Evidence not found: ${evidenceId}`)
    return record
  }

  list(): EvidenceRecord[] {
    return [...this.#records.values()]
  }
}
