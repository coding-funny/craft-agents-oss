import type { DataKind, DataSnapshot } from '../data/contracts.ts'
import type { EvidenceRecord } from '../domain/contracts.ts'

export type EvidenceHealth = 'FRESH' | 'STALE' | 'INCOMPLETE' | 'CONFLICT'

export type FreshnessPolicy = Record<DataKind, number>

export const DEFAULT_FRESHNESS_POLICY: FreshnessPolicy = {
  sales: 24 * 60 * 60 * 1000,
  inventory: 6 * 60 * 60 * 1000,
  promotions: 24 * 60 * 60 * 1000,
  products: 30 * 24 * 60 * 60 * 1000,
  ads: 24 * 60 * 60 * 1000,
}

export type SnapshotHealthResult = {
  health: EvidenceHealth
  reasons: string[]
  byKind: Record<DataKind, EvidenceHealth>
}

export function evaluateSnapshotHealth(
  snapshot: DataSnapshot,
  now: string,
  policy: FreshnessPolicy = DEFAULT_FRESHNESS_POLICY,
): SnapshotHealthResult {
  const age = Date.parse(now) - Date.parse(snapshot.asOf)
  const byKind = {} as Record<DataKind, EvidenceHealth>
  const reasons: string[] = []
  for (const kind of Object.keys(snapshot.completeness) as DataKind[]) {
    const completeness = snapshot.completeness[kind]
    if (completeness !== 'complete') {
      byKind[kind] = 'INCOMPLETE'
      reasons.push(`${kind} is ${completeness}`)
    } else if (age > policy[kind]) {
      byKind[kind] = 'STALE'
      reasons.push(`${kind} is older than its freshness policy`)
    } else byKind[kind] = 'FRESH'
  }
  const values = Object.values(byKind)
  return {
    health: values.includes('INCOMPLETE') ? 'INCOMPLETE' : values.includes('STALE') ? 'STALE' : 'FRESH',
    reasons,
    byKind,
  }
}

export function evidenceSetHealth(records: EvidenceRecord[]): { health: EvidenceHealth; reasons: string[] } {
  const governed = records.map(record => record.governance)
  if (governed.some(value => !value)) return { health: 'INCOMPLETE', reasons: ['one or more evidence records lack governance metadata'] }
  const scopes = new Set(governed.map(value => `${value!.tenantId}:${value!.shopId}`))
  const snapshots = new Set(governed.map(value => value!.snapshotId))
  const currencies = new Set(records.map(record => String(record.query.currency ?? '')))
  const reasons: string[] = []
  if (scopes.size > 1) reasons.push('evidence spans multiple tenant/shop scopes')
  if (snapshots.size > 1) reasons.push('evidence spans multiple snapshots')
  if (currencies.size > 1) reasons.push('evidence spans multiple currencies')
  return reasons.length > 0 ? { health: 'CONFLICT', reasons } : { health: 'FRESH', reasons: [] }
}
