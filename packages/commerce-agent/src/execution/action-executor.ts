import type { ActionType } from '../reports/schema.ts'

export type ActionRequest = {
  requestId: string
  idempotencyKey: string
  tenantId: string
  shopId: string
  proposalId: string
  actionType: ActionType
  targetId: string
  expectedVersion: number
  parameters: Record<string, string | number | boolean>
  contentHash: string
}

export type ExecutorCapabilities = {
  idempotency: 'SUPPORTED' | 'UNSUPPORTED'
  lookup: 'AUTHORITATIVE' | 'EVENTUAL' | 'UNAVAILABLE'
  visibilityLagMs?: number
}

export type ActionOutcome = {
  status: 'APPLIED' | 'REJECTED' | 'PENDING'
  operationId?: string
  before?: unknown
  after?: unknown
  reason?: string
}

export type LookupOutcome = ActionOutcome | {
  status: 'NOT_FOUND' | 'UNAVAILABLE'
  reason?: string
}

export interface ActionExecutor {
  capabilities(): ExecutorCapabilities
  execute(request: ActionRequest, signal?: AbortSignal): Promise<ActionOutcome>
  lookup(requestId: string, signal?: AbortSignal): Promise<LookupOutcome>
}
