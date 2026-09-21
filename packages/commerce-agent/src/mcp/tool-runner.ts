import { randomUUID } from 'node:crypto'
import { ZodError } from 'zod'
import type { ToolEnvelope } from '../domain/contracts.ts'
import { CommerceError } from '../domain/errors.ts'
import {
  MemoryTraceRecorder,
  redactErrorMessage,
  summarizeArguments,
  type TraceRecorder,
} from './trace.ts'

export type ToolRunnerOptions = {
  timeoutMs?: number
  maxAttempts?: number
  retryBudgetMs?: number
  baseDelayMs?: number
  maxResultBytes?: number
  random?: () => number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  traceRecorder?: TraceRecorder
}

export type ToolExecutionContext = {
  traceId: string
  toolCallId: string
  attempt: number
  signal: AbortSignal
}

type ToolHandler<T> = (args: Record<string, unknown>, context: ToolExecutionContext) => Promise<T>

const DEFAULT_TIMEOUT_MS = 5_000
const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_RETRY_BUDGET_MS = 2_000
const DEFAULT_BASE_DELAY_MS = 50
const DEFAULT_MAX_RESULT_BYTES = 64 * 1024

function normalizeError(error: unknown): CommerceError {
  if (error instanceof CommerceError) return error
  if (error instanceof ZodError) {
    return new CommerceError('INVALID_ARGUMENT', 'Tool arguments failed validation', {
      issues: error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })),
    })
  }
  return new CommerceError('INTERNAL', error instanceof Error ? error.message : String(error))
}

function isRetryable(error: CommerceError): boolean {
  return error.code === 'RATE_LIMITED' || error.code === 'UPSTREAM_TIMEOUT'
}

function evidenceIdsFrom(value: unknown): string[] {
  if (!value || typeof value !== 'object') return []
  const evidence = (value as { evidence?: unknown }).evidence
  if (!Array.isArray(evidence)) return []
  return evidence.flatMap(item => {
    if (!item || typeof item !== 'object') return []
    const evidenceId = (item as { evidenceId?: unknown }).evidenceId
    return typeof evidenceId === 'string' ? [evidenceId] : []
  })
}

export function truncateToolEnvelope<T>(envelope: ToolEnvelope<T>, maxBytes: number): ToolEnvelope<T> {
  const serialized = JSON.stringify(envelope)
  const originalBytes = Buffer.byteLength(serialized)
  if (originalBytes <= maxBytes) return envelope

  const previewBudget = Math.max(64, Math.floor(maxBytes / 3))
  const dataPreview = JSON.stringify(envelope.data).slice(0, previewBudget)
  return {
    ...envelope,
    data: {
      truncated: true,
      preview: dataPreview,
    } as T,
    warnings: [...envelope.warnings, `Result truncated from ${originalBytes} bytes; use evidence IDs for full data.`],
    truncated: true,
    originalBytes,
  }
}

export class ToolRunner {
  readonly traceRecorder: TraceRecorder
  readonly #timeoutMs: number
  readonly #maxAttempts: number
  readonly #retryBudgetMs: number
  readonly #baseDelayMs: number
  readonly #maxResultBytes: number
  readonly #random: () => number
  readonly #now: () => number
  readonly #sleep: (ms: number) => Promise<void>

  constructor(options: ToolRunnerOptions = {}) {
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.#maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
    this.#retryBudgetMs = options.retryBudgetMs ?? DEFAULT_RETRY_BUDGET_MS
    this.#baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS
    this.#maxResultBytes = options.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES
    this.#random = options.random ?? Math.random
    this.#now = options.now ?? Date.now
    this.#sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
    this.traceRecorder = options.traceRecorder ?? new MemoryTraceRecorder()
  }

  async execute<T extends ToolEnvelope<unknown>>(
    tool: string,
    rawArgs: Record<string, unknown>,
    handler: ToolHandler<T>,
  ): Promise<T> {
    const traceId = typeof rawArgs.trace_id === 'string' && rawArgs.trace_id.length > 0
      ? rawArgs.trace_id
      : `trace-${randomUUID()}`
    const toolCallId = `call-${randomUUID()}`
    const args = { ...rawArgs, trace_id: traceId }
    const executionStarted = this.#now()

    for (let attempt = 1; attempt <= this.#maxAttempts; attempt++) {
      const attemptStarted = this.#now()
      const startedAt = new Date(attemptStarted).toISOString()
      const controller = new AbortController()

      try {
        const result = await this.#withTimeout(
          handler(args, { traceId, toolCallId, attempt, signal: controller.signal }),
          controller,
        )
        const truncated = truncateToolEnvelope(result, this.#maxResultBytes) as T
        this.traceRecorder.record({
          traceId,
          toolCallId,
          tool,
          attempt,
          status: 'succeeded',
          startedAt,
          durationMs: Math.max(0, this.#now() - attemptStarted),
          argumentSummary: summarizeArguments(args),
          evidenceIds: evidenceIdsFrom(truncated),
        })
        return { ...truncated, attempts: attempt }
      } catch (caught) {
        const error = normalizeError(caught)
        const elapsed = this.#now() - executionStarted
        const delayMs = Math.round(this.#baseDelayMs * 2 ** (attempt - 1) * (0.5 + this.#random()))
        const retry = isRetryable(error)
          && attempt < this.#maxAttempts
          && elapsed + delayMs <= this.#retryBudgetMs
        this.traceRecorder.record({
          traceId,
          toolCallId,
          tool,
          attempt,
          status: retry ? 'retrying' : 'failed',
          startedAt,
          durationMs: Math.max(0, this.#now() - attemptStarted),
          argumentSummary: summarizeArguments(args),
          evidenceIds: [],
          errorCode: error.code,
          errorMessage: redactErrorMessage(error.message),
        })
        if (!retry) {
          throw new CommerceError(error.code, error.message, {
            ...error.details,
            traceId,
            toolCallId,
            attempts: attempt,
          })
        }
        await this.#sleep(delayMs)
      }
    }

    throw new CommerceError('INTERNAL', 'Tool runner exhausted attempts without a result')
  }

  #withTimeout<T>(promise: Promise<T>, controller: AbortController): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        controller.abort()
        reject(new CommerceError('UPSTREAM_TIMEOUT', `Tool call exceeded ${this.#timeoutMs}ms timeout`))
      }, this.#timeoutMs)
      promise.then(
        value => {
          clearTimeout(timeout)
          resolve(value)
        },
        error => {
          clearTimeout(timeout)
          reject(error)
        },
      )
    })
  }
}
