import type { Proposal } from '../approvals/repository.ts'
import type { InvestigationTask } from '../contracts/task.ts'
import type { DurableJobRepository } from './repository.ts'
import type { OutboxRepository } from './outbox.ts'

export function createTaskJobSink(jobs: DurableJobRepository, outbox: OutboxRepository) {
  return (task: InvestigationTask, now: string): void => {
    const shopId = task.resolvedScope?.shopId ?? task.input.scope?.shopId
    // An unresolved task is already durable in investigation_tasks and awaits
    // scoped user input. It must not enter a shop-scoped worker queue under a
    // synthetic shop identity.
    if (!shopId) return
    jobs.enqueue({
      kind: 'INVESTIGATE', tenantId: task.tenantId, shopId,
      businessKey: `${task.taskId}:v${task.version}`, payload: { taskId: task.taskId, taskVersion: task.version }, now,
    })
    outbox.append({
      tenantId: task.tenantId, shopId, aggregateType: 'InvestigationTask', aggregateId: task.taskId,
      eventType: 'INVESTIGATION_TASK_QUEUED', idempotencyKey: `task:${task.taskId}:v${task.version}:queued`,
      payload: { taskId: task.taskId, taskVersion: task.version, shopId }, now,
    })
  }
}

export function createApprovalDecisionSink(jobs: DurableJobRepository, outbox: OutboxRepository) {
  return (proposal: Proposal, decision: 'APPROVED' | 'REJECTED', now: string): void => {
    outbox.append({
      tenantId: proposal.tenantId, shopId: proposal.shopId, aggregateType: 'Proposal', aggregateId: proposal.proposalId,
      eventType: `PROPOSAL_${decision}`, idempotencyKey: `proposal:${proposal.proposalId}:${decision}`,
      payload: { proposalId: proposal.proposalId, shopId: proposal.shopId, contentHash: proposal.contentHash }, now,
    })
    if (decision === 'APPROVED') {
      jobs.enqueue({
        kind: 'EXECUTE', tenantId: proposal.tenantId, shopId: proposal.shopId,
        businessKey: proposal.proposalId, payload: { proposalId: proposal.proposalId }, priority: 10, now,
      })
    }
  }
}
