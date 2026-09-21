import type { AuthenticatedPrincipal } from '../auth/contracts.ts'
import type { InvestigationResult } from '../contracts/runtime.ts'
import type { ReliableExecutionService } from '../execution/reliable-execution-service.ts'
import type { JobHandler } from './contracts.ts'
import { CancelledJobError, ManualReviewJobError, RetryableJobError, WaitingInputJobError } from './contracts.ts'

export function createInvestigationJobHandler(
  run: (input: { taskId: string; taskVersion: number; signal: AbortSignal }) => Promise<InvestigationResult>,
): JobHandler {
  return async context => {
    const payload = context.lease.payload as { taskId?: string; taskVersion?: number }
    if (!payload.taskId || !Number.isSafeInteger(payload.taskVersion)) {
      throw new ManualReviewJobError('Investigation job payload is invalid')
    }
    const result = await run({ taskId: payload.taskId, taskVersion: payload.taskVersion!, signal: context.signal })
    context.checkpoint('investigation-result', {
      runId: result.runId, status: result.status, reportId: result.report?.reportId, manifestId: result.manifestId,
    })
    if (result.status === 'WAITING_INPUT') throw new WaitingInputJobError(result.completionReason)
    if (result.status === 'TIMED_OUT') throw new RetryableJobError(result.completionReason)
    if (result.status === 'CANCELLED') throw new CancelledJobError(result.completionReason)
    if (result.status === 'FAILED') {
      throw new ManualReviewJobError(result.error?.message ?? result.completionReason)
    }
  }
}

export function createReliableExecutionJobHandlers(
  service: ReliableExecutionService,
  principalFor: (tenantId: string, shopId: string) => AuthenticatedPrincipal,
): { EXECUTE: JobHandler; RECONCILE: JobHandler } {
  const handle: JobHandler = async context => {
    const payload = context.lease.payload as { proposalId?: string }
    if (!payload.proposalId) throw new ManualReviewJobError('Execution job payload is invalid')
    if (context.isCancellationRequested()) throw new CancelledJobError('Cancellation requested before action dispatch')
    const principal = principalFor(context.lease.tenantId, context.lease.shopId)
    const request = await service.execute({ proposalId: payload.proposalId, principal, signal: context.signal })
    context.checkpoint('execution-request', {
      requestId: request.requestId, status: request.status, lookupAttempts: request.lookupAttempts,
    })
    if (request.status === 'UNKNOWN' || request.status === 'SENT') {
      const delay = request.nextLookupAt ? Math.max(0, Date.parse(request.nextLookupAt) - Date.now()) : undefined
      throw new RetryableJobError('Execution result is still unknown', delay)
    }
    if (request.status === 'MANUAL_REVIEW') throw new ManualReviewJobError(request.lastError ?? 'Execution requires manual review')
    if (request.status === 'REJECTED') throw new ManualReviewJobError('Remote platform rejected the action')
  }
  return { EXECUTE: handle, RECONCILE: handle }
}
