import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type ToolTraceStatus = 'succeeded' | 'failed' | 'retrying'

export type ToolTraceRecord = {
  traceId: string
  toolCallId: string
  tool: string
  attempt: number
  status: ToolTraceStatus
  startedAt: string
  durationMs: number
  argumentSummary: unknown
  evidenceIds: string[]
  errorCode?: string
  errorMessage?: string
}

export interface TraceRecorder {
  record(entry: ToolTraceRecord): void
}

export class MemoryTraceRecorder implements TraceRecorder {
  readonly records: ToolTraceRecord[] = []

  record(entry: ToolTraceRecord): void {
    this.records.push(structuredClone(entry))
  }
}

export class JsonlTraceRecorder implements TraceRecorder {
  readonly #path: string

  constructor(path: string) {
    this.#path = path
    mkdirSync(dirname(path), { recursive: true })
  }

  record(entry: ToolTraceRecord): void {
    appendFileSync(this.#path, `${JSON.stringify(entry)}\n`, 'utf8')
  }
}

const SENSITIVE_KEY = /(api[_-]?key|token|secret|password|authorization|credential)/i

export function summarizeArguments(value: unknown, depth = 0): unknown {
  if (depth > 3) return '[depth-limited]'
  if (Array.isArray(value)) {
    return {
      count: value.length,
      preview: value.slice(0, 5).map(item => summarizeArguments(item, depth + 1)),
    }
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      key,
      SENSITIVE_KEY.test(key) ? '[REDACTED]' : summarizeArguments(child, depth + 1),
    ]))
  }
  if (typeof value === 'string' && value.length > 200) return `${value.slice(0, 200)}…`
  return value
}

export function redactErrorMessage(message: string): string {
  return message
    .replace(/(bearer\s+)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|token|secret|password)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]')
}
