import { createHash } from 'node:crypto'

export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]))
  }
  return value
}

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

export function contentHash(value: unknown): string {
  return sha256(JSON.stringify(canonicalize(value)))
}

export function stableId(prefix: string, value: unknown): string {
  return `${prefix}_${contentHash(value).slice(0, 24)}`
}
