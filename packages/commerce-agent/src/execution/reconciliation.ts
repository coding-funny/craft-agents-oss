import type { ExecutionAttempt } from '../approvals/repository.ts'

export type ReconciliationResult = {
  status: 'SUCCEEDED' | 'FAILED'
  reason: string
  attempt: ExecutionAttempt
}
