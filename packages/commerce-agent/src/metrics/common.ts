import type { EvidenceRef, MetricValue } from '../domain/contracts.ts'
import { invalidArgument } from '../domain/errors.ts'

export function metric<T>(value: T, unit: string, evidence: EvidenceRef[]): MetricValue<T> {
  if (evidence.length === 0) throw invalidArgument('Metrics require at least one evidence reference')
  return { value, unit, evidence }
}

export function assertSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value)) throw invalidArgument(`${label} exceeds the safe integer range`, { value })
  return value
}

export function sumSafe(values: number[], label: string): number {
  return values.reduce((total, value) => assertSafeInteger(total + value, label), 0)
}

export function singleCurrency(currencies: string[]): string | null {
  const unique = [...new Set(currencies)]
  if (unique.length > 1) throw invalidArgument('Cannot aggregate multiple currencies', { currencies: unique })
  return unique[0] ?? null
}

export function ratio(numerator: number, denominator: number, precision = 4): number | null {
  if (denominator === 0) return null
  const factor = 10 ** precision
  return Math.round((numerator / denominator) * factor) / factor
}

export function isInRange(instant: string, start: string, end: string): boolean {
  const value = Date.parse(instant)
  return value >= Date.parse(start) && value < Date.parse(end)
}

export function durationDays(start: string, end: string): number {
  const duration = Date.parse(end) - Date.parse(start)
  if (duration <= 0) throw invalidArgument('Metric time range must have positive duration')
  return duration / 86_400_000
}

export function deduplicateBy<T>(rows: T[], keyOf: (row: T) => string): T[] {
  const unique = new Map<string, T>()
  for (const row of rows) {
    const key = keyOf(row)
    const existing = unique.get(key)
    if (existing && JSON.stringify(existing) !== JSON.stringify(row)) {
      throw invalidArgument(`Conflicting duplicate record: ${key}`)
    }
    if (!existing) unique.set(key, row)
  }
  return [...unique.values()]
}

export function mergeEvidence(...groups: EvidenceRef[][]): EvidenceRef[] {
  const refs = new Map<string, EvidenceRef>()
  for (const ref of groups.flat()) refs.set(`${ref.evidenceId}:${ref.traceId}`, ref)
  return [...refs.values()]
}
