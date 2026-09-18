import type { BudgetConfig, UsageRecord } from '../contracts/runtime.ts'
import { CommerceError } from '../domain/errors.ts'

export type BudgetSnapshot = {
  steps: number
  modelRequests: number
  toolCalls: number
  toolAttempts: number
  reportRepairs: number
  usage: UsageRecord
}

const ZERO_USAGE: UsageRecord = {
  inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costMicros: 0, source: 'actual',
}

export class BudgetLedger {
  readonly config: BudgetConfig
  #snapshot: BudgetSnapshot = {
    steps: 0, modelRequests: 0, toolCalls: 0, toolAttempts: 0, reportRepairs: 0, usage: { ...ZERO_USAGE },
  }

  constructor(config: BudgetConfig, initial?: Partial<BudgetSnapshot>) {
    this.config = config
    if (initial) this.#snapshot = { ...this.#snapshot, ...initial, usage: { ...ZERO_USAGE, ...initial.usage } }
  }

  reserveModel(): void {
    if (this.#snapshot.modelRequests + 1 > this.config.maxModelRequests) this.#exceeded('model request')
    if (this.#snapshot.steps + 1 > this.config.maxSteps) this.#exceeded('step')
    this.#snapshot.modelRequests += 1
    this.#snapshot.steps += 1
  }

  settleModel(usage: UsageRecord): void {
    const nextInput = this.#snapshot.usage.inputTokens + usage.inputTokens
    const nextOutput = this.#snapshot.usage.outputTokens + usage.outputTokens
    const nextCost = this.#snapshot.usage.costMicros + usage.costMicros
    if (nextInput > this.config.maxTotalInputTokens) this.#exceeded('input token')
    if (nextOutput > this.config.maxTotalOutputTokens) this.#exceeded('output token')
    if (nextCost > this.config.maxEstimatedCostMicros) this.#exceeded('estimated cost')
    this.#snapshot.usage = {
      inputTokens: nextInput,
      outputTokens: nextOutput,
      cacheReadTokens: this.#snapshot.usage.cacheReadTokens + usage.cacheReadTokens,
      cacheWriteTokens: this.#snapshot.usage.cacheWriteTokens + usage.cacheWriteTokens,
      reasoningTokens: (this.#snapshot.usage.reasoningTokens ?? 0) + (usage.reasoningTokens ?? 0),
      costMicros: nextCost,
      source: this.#snapshot.usage.source === 'unknown' || usage.source === 'unknown'
        ? 'unknown'
        : this.#snapshot.usage.source === 'estimated' || usage.source === 'estimated' ? 'estimated' : 'actual',
    }
  }

  reserveTools(count: number): void {
    if (count < 0 || this.#snapshot.toolCalls + count > this.config.maxToolCalls) this.#exceeded('tool call')
    this.#snapshot.toolCalls += count
  }

  recordToolAttempt(): void {
    this.recordToolAttempts(1)
  }

  recordToolAttempts(count: number): void {
    if (!Number.isSafeInteger(count) || count < 1 || this.#snapshot.toolAttempts + count > this.config.maxToolAttempts) {
      this.#exceeded('tool attempt')
    }
    this.#snapshot.toolAttempts += count
  }

  recordReportRepair(): void {
    if (this.#snapshot.reportRepairs + 1 > this.config.maxReportRepairs) {
      throw new CommerceError('REPORT_NOT_VALIDATED', 'Report repair budget exceeded')
    }
    this.#snapshot.reportRepairs += 1
  }

  snapshot(): BudgetSnapshot { return structuredClone(this.#snapshot) }

  #exceeded(kind: string): never {
    throw new CommerceError('BUDGET_EXCEEDED', `Investigation ${kind} budget exceeded`)
  }
}
