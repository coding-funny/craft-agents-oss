import { randomUUID } from 'node:crypto'
import { CommerceError } from '../domain/errors.ts'
import type { AuthenticatedPrincipal } from '../auth/contracts.ts'
import { requirePermission, requireShopAccess } from '../auth/authorization.ts'
import {
  assertProposalIntegrity,
  ProposalRepository,
  type ExecutionAttempt,
  type Proposal,
} from '../approvals/repository.ts'
import type { MockOperation } from './mock-executor.ts'
import { MockExecutor } from './mock-executor.ts'
import type { ReconciliationResult } from './reconciliation.ts'

export type ExecutionResult = {
  proposal: Proposal
  attempt: ExecutionAttempt
  operation?: MockOperation
  replayed: boolean
}

export class ExecutionService {
  readonly #repository: ProposalRepository
  readonly #executor: MockExecutor
  readonly #now: () => Date
  readonly #approvalGuard?: (proposal: Proposal, approval: ReturnType<ProposalRepository['latestApproval']>) => void

  constructor(options: {
    repository: ProposalRepository; executor: MockExecutor; now?: () => Date
    approvalGuard?: (proposal: Proposal, approval: ReturnType<ProposalRepository['latestApproval']>) => void
  }) {
    this.#repository = options.repository
    this.#executor = options.executor
    this.#now = options.now ?? (() => new Date())
    this.#approvalGuard = options.approvalGuard
  }

  execute(input: { proposalId: string; principal: AuthenticatedPrincipal; simulateResponseLoss?: boolean }): ExecutionResult {
    let proposal = this.#repository.getOrThrow(input.proposalId)
    this.#authorizeExecutor(input.principal, proposal)
    try {
      assertProposalIntegrity(proposal)
    } catch (error) {
      this.#repository.audit({
        proposalId: proposal.proposalId, traceId: proposal.traceId, actor: input.principal.actorId,
        eventType: 'EXECUTION_BLOCKED', details: { reason: 'content-hash-mismatch' }, createdAt: this.#now().toISOString(),
      })
      throw error
    }
    const priorAttempt = this.#repository.getAttemptByIdempotencyKey(proposal.idempotencyKey)
    if (proposal.status === 'SUCCEEDED' && priorAttempt) {
      this.#repository.audit({
        proposalId: proposal.proposalId, traceId: proposal.traceId, actor: input.principal.actorId,
        eventType: 'EXECUTION_REPLAYED', details: { status: proposal.status }, createdAt: this.#now().toISOString(),
      })
      return { proposal, attempt: priorAttempt, operation: this.#executor.getOperation(proposal.idempotencyKey), replayed: true }
    }
    if (proposal.status === 'UNKNOWN' && priorAttempt) {
      this.#repository.audit({
        proposalId: proposal.proposalId, traceId: proposal.traceId, actor: input.principal.actorId,
        eventType: 'EXECUTION_REPLAY_BLOCKED', details: { status: proposal.status }, createdAt: this.#now().toISOString(),
      })
      return { proposal, attempt: priorAttempt, replayed: true }
    }
    if (proposal.status !== 'APPROVED') {
      this.#repository.audit({
        proposalId: proposal.proposalId, traceId: proposal.traceId, actor: input.principal.actorId,
        eventType: 'EXECUTION_BLOCKED', details: { status: proposal.status }, createdAt: this.#now().toISOString(),
      })
      throw new CommerceError('INVALID_ARGUMENT', `Proposal cannot execute from status: ${proposal.status}`)
    }
    const approval = this.#repository.latestApproval(proposal.proposalId)
    if (!approval || approval.decision !== 'APPROVED' || approval.contentHash !== proposal.contentHash) {
      this.#repository.audit({
        proposalId: proposal.proposalId, traceId: proposal.traceId, actor: input.principal.actorId,
        eventType: 'EXECUTION_BLOCKED', details: { reason: 'invalid-approval' }, createdAt: this.#now().toISOString(),
      })
      throw new CommerceError('INVALID_ARGUMENT', 'Proposal does not have a valid approval for its current content')
    }
    this.#approvalGuard?.(proposal, approval)
    const now = this.#now().toISOString()
    if (Date.parse(proposal.expiresAt) <= Date.parse(now)) {
      this.#repository.transaction(() => {
        this.#repository.transition(proposal.proposalId, 'APPROVED', 'EXPIRED')
        this.#repository.audit({
          proposalId: proposal.proposalId, traceId: proposal.traceId, actor: input.principal.actorId,
          eventType: 'EXECUTION_BLOCKED_EXPIRED', fromStatus: 'APPROVED', toStatus: 'EXPIRED', createdAt: now,
        })
      })
      throw new CommerceError('INVALID_ARGUMENT', 'Proposal approval has expired')
    }
    const attempt: ExecutionAttempt = {
      attemptId: `attempt_${randomUUID()}`,
      proposalId: proposal.proposalId,
      idempotencyKey: proposal.idempotencyKey,
      status: 'EXECUTING',
      createdAt: now,
      updatedAt: now,
    }
    proposal = this.#repository.transaction(() => {
      const executing = this.#repository.transition(proposal.proposalId, 'APPROVED', 'EXECUTING')
      this.#repository.audit({
        proposalId: executing.proposalId, traceId: executing.traceId, actor: input.principal.actorId,
        eventType: 'EXECUTION_STARTED', fromStatus: 'APPROVED', toStatus: 'EXECUTING', createdAt: now,
      })
      this.#repository.insertAttempt(attempt)
      return executing
    })
    let operation: MockOperation | undefined
    try {
      const applied = this.#executor.apply(proposal)
      operation = applied
      const nextStatus = input.simulateResponseLoss ? 'UNKNOWN' : 'SUCCEEDED'
      const updatedAt = this.#now().toISOString()
      proposal = this.#repository.transaction(() => {
        this.#repository.updateAttempt(attempt.attemptId, {
          status: nextStatus,
          externalOperationId: applied.operationId,
          before: applied.before,
          after: applied.after,
          result: { operationId: applied.operationId },
          updatedAt,
        })
        const completed = this.#repository.transition(proposal.proposalId, 'EXECUTING', nextStatus)
        this.#repository.audit({
          proposalId: completed.proposalId, traceId: completed.traceId, actor: input.principal.actorId,
          eventType: nextStatus === 'UNKNOWN' ? 'EXECUTION_RESPONSE_LOST' : 'EXECUTION_SUCCEEDED',
          fromStatus: 'EXECUTING', toStatus: nextStatus, details: { operationId: applied.operationId }, createdAt: updatedAt,
        })
        return completed
      })
      return { proposal, attempt: this.#repository.getAttemptById(attempt.attemptId)!, operation: applied, replayed: false }
    } catch (error) {
      const updatedAt = this.#now().toISOString()
      const failureStatus = operation ? 'UNKNOWN' : 'FAILED'
      this.#repository.transaction(() => {
        this.#repository.updateAttempt(attempt.attemptId, {
          status: failureStatus,
          externalOperationId: operation?.operationId,
          before: operation?.before,
          after: operation?.after,
          result: { error: error instanceof Error ? error.message : String(error) },
          updatedAt,
        })
        proposal = this.#repository.transition(proposal.proposalId, 'EXECUTING', failureStatus)
        this.#repository.audit({
          proposalId: proposal.proposalId, traceId: proposal.traceId, actor: input.principal.actorId,
          eventType: operation ? 'EXECUTION_RESULT_UNCERTAIN' : 'EXECUTION_FAILED',
          fromStatus: 'EXECUTING', toStatus: failureStatus,
          details: { error: error instanceof Error ? error.message : String(error), operationId: operation?.operationId },
          createdAt: updatedAt,
        })
      })
      throw error
    }
  }

  reconcile(input: { proposalId: string; principal: AuthenticatedPrincipal }): ReconciliationResult {
    let proposal = this.#repository.getOrThrow(input.proposalId)
    this.#authorizeExecutor(input.principal, proposal)
    if (proposal.status !== 'UNKNOWN') throw new CommerceError('INVALID_ARGUMENT', `Only UNKNOWN proposals can be reconciled: ${proposal.status}`)
    const attempt = this.#repository.getAttemptByIdempotencyKey(proposal.idempotencyKey)
    if (!attempt) throw new CommerceError('NOT_FOUND', 'Execution attempt is missing')
    const operation = this.#executor.getOperation(proposal.idempotencyKey)
    const status = operation ? 'SUCCEEDED' : 'FAILED'
    const now = this.#now().toISOString()
    proposal = this.#repository.transaction(() => {
      this.#repository.updateAttempt(attempt.attemptId, {
        status,
        externalOperationId: operation?.operationId,
        before: operation?.before,
        after: operation?.after,
        result: operation ? { reconciledOperationId: operation.operationId } : { reconciled: 'not-applied' },
        updatedAt: now,
      })
      const reconciled = this.#repository.transition(proposal.proposalId, 'UNKNOWN', status)
      this.#repository.audit({
        proposalId: reconciled.proposalId, traceId: reconciled.traceId, actor: input.principal.actorId,
        eventType: 'EXECUTION_RECONCILED', fromStatus: 'UNKNOWN', toStatus: status,
        details: { operationId: operation?.operationId }, createdAt: now,
      })
      return reconciled
    })
    return { status, reason: operation ? 'Mock operation exists in external ledger.' : 'No mock operation found.', attempt: this.#repository.getAttemptById(attempt.attemptId)! }
  }

  #authorizeExecutor(principal: AuthenticatedPrincipal, proposal: Proposal): void {
    if (principal.authSource !== 'service-identity') {
      throw new CommerceError('SCOPE_DENIED', 'Execution requires a dedicated service identity')
    }
    requirePermission(principal, 'proposal:execute')
    requireShopAccess(principal, proposal.shopId)
    if (principal.tenantId !== proposal.tenantId) throw new CommerceError('SCOPE_DENIED', 'Proposal is outside executor tenant scope')
  }
}
