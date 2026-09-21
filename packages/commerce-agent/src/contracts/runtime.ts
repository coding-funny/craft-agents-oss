import { z } from 'zod'

export const RUN_STATUSES = [
  'QUEUED', 'RUNNING', 'WAITING_INPUT', 'REPORT_READY', 'FAILED', 'CANCELLED', 'TIMED_OUT',
] as const
export type RunStatus = (typeof RUN_STATUSES)[number]

export const TERMINAL_RUN_STATUSES = new Set<RunStatus>([
  'WAITING_INPUT', 'REPORT_READY', 'FAILED', 'CANCELLED', 'TIMED_OUT',
])

export const BudgetConfigSchema = z.object({
  maxSteps: z.number().int().min(1).max(50).default(8),
  maxModelRequests: z.number().int().min(1).max(50).default(10),
  maxToolCalls: z.number().int().min(1).max(100).default(16),
  maxToolAttempts: z.number().int().min(1).max(200).default(24),
  maxParallelTools: z.number().int().min(1).max(8).default(2),
  maxReportRepairs: z.number().int().min(0).max(5).default(2),
  maxContextInputTokens: z.number().int().min(1).default(12_000),
  maxOutputTokensPerRequest: z.number().int().min(1).default(2_048),
  maxTotalInputTokens: z.number().int().min(1).default(48_000),
  maxTotalOutputTokens: z.number().int().min(1).default(12_000),
  runTimeoutMs: z.number().int().min(100).default(120_000),
  toolTimeoutMs: z.number().int().min(100).default(10_000),
  maxEstimatedCostMicros: z.number().int().min(1),
  priceVersion: z.string().min(1),
}).strict()

export type BudgetConfig = z.infer<typeof BudgetConfigSchema>

export type UsageRecord = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens?: number
  costMicros: number
  source: 'actual' | 'estimated' | 'unknown'
}

export type RunManifest = {
  schemaVersion: 1
  manifestId: string
  driver: string
  modelId: string
  modelVersion?: string
  modelMode: 'fake' | 'live'
  promptVersion: string
  toolVersion: string
  schemaVersionName: string
  fixtureDigest: string
  usage: UsageRecord
  steps: number
  modelRequests: number
  toolCalls: number
  toolAttempts: number
  reportRepairs: number
  completionReason: string
  reportStatus?: 'RESOLVED' | 'NEEDS_DATA' | 'UNRESOLVED'
}

export type InvestigationResult = {
  schemaVersion: 1
  taskId: string
  runId: string
  traceId: string
  status: RunStatus
  report?: { reportId: string; status: 'RESOLVED' | 'NEEDS_DATA' | 'UNRESOLVED' }
  clarification?: {
    requestId: string
    expectedTaskVersion: number
    fields: string[]
    question: string
  }
  completionReason: string
  error?: { code: string; retryable: boolean; message: string }
  manifestId: string
}
