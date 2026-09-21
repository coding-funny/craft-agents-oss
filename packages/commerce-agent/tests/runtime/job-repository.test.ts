import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { CommerceDatabase } from '../../src/storage/database.ts'
import { DurableJobRepository } from '../../src/jobs/repository.ts'
import { DurableWorker } from '../../src/jobs/worker.ts'
import { RetryableJobError } from '../../src/jobs/contracts.ts'
import { OutboxRepository } from '../../src/jobs/outbox.ts'
import { createTaskJobSink } from '../../src/jobs/integration.ts'
import { createInvestigationTask } from '../../src/contracts/task.ts'
import { InvestigationRepository } from '../../src/storage/investigation-repository.ts'
import { COMPLETE_INPUT, TEST_BUDGET, TEST_PRINCIPAL } from '../agent/helpers.ts'

const roots: string[] = []
function databasePath(): string {
  const root = mkdtempSync(resolve(tmpdir(), 'commerce-jobs-'))
  roots.push(root)
  return resolve(root, 'runtime.sqlite')
}
const at = (seconds: number) => new Date(Date.parse('2026-09-18T00:00:00.000Z') + seconds * 1_000).toISOString()

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('durable job leases', () => {
  it('allows one claimant and fences the old epoch after lease takeover', () => {
    const path = databasePath()
    const firstStore = new CommerceDatabase(path)
    const secondStore = new CommerceDatabase(path)
    const first = new DurableJobRepository(firstStore)
    const second = new DurableJobRepository(secondStore)
    const job = first.enqueue({
      kind: 'INVESTIGATE', tenantId: 'tenant-a', shopId: 'shop-a', businessKey: 'task-1',
      payload: { taskId: 'task-1' }, now: at(0), maxAttempts: 3,
    })
    const lease1 = first.claim({ workerId: 'worker-1', kinds: ['INVESTIGATE'], now: at(0), leaseMs: 1_000 })!
    expect(second.claim({ workerId: 'worker-2', kinds: ['INVESTIGATE'], now: at(0), leaseMs: 1_000 })).toBeUndefined()
    expect(second.recoverExpired(at(2))).toBe(1)
    const lease2 = second.claim({ workerId: 'worker-2', kinds: ['INVESTIGATE'], now: at(2), leaseMs: 1_000 })!
    expect(lease2.jobId).toBe(job.jobId)
    expect(lease2.leaseEpoch).toBe(lease1.leaseEpoch + 1)
    expect(first.heartbeat({ jobId: job.jobId, owner: 'worker-1', epoch: lease1.leaseEpoch }, at(2), 1_000)).toBe(false)
    expect(first.checkpoint({ jobId: job.jobId, owner: 'worker-1', epoch: lease1.leaseEpoch }, 'late', {}, at(2))).toBe(false)
    expect(first.succeed({ jobId: job.jobId, owner: 'worker-1', epoch: lease1.leaseEpoch }, at(2))).toBe(false)
    expect(second.succeed({ jobId: job.jobId, owner: 'worker-2', epoch: lease2.leaseEpoch }, at(2))).toBe(true)
    expect(second.get(job.jobId)?.status).toBe('SUCCEEDED')
    firstStore.close(); secondStore.close()
  })

  it('enforces tenant concurrency fairness and distinguishes queued from in-flight cancellation', () => {
    const store = new CommerceDatabase(databasePath())
    const repository = new DurableJobRepository(store)
    repository.enqueue({ kind: 'INVESTIGATE', tenantId: 'tenant-a', shopId: 'shop-a', businessKey: 'a1', payload: {}, priority: 100, now: at(0) })
    repository.enqueue({ kind: 'INVESTIGATE', tenantId: 'tenant-a', shopId: 'shop-a', businessKey: 'a2', payload: {}, priority: 90, now: at(0) })
    const other = repository.enqueue({ kind: 'INVESTIGATE', tenantId: 'tenant-b', shopId: 'shop-b', businessKey: 'b1', payload: {}, now: at(0) })
    const first = repository.claim({ workerId: 'w1', kinds: ['INVESTIGATE'], now: at(0), leaseMs: 10_000, maxActivePerTenant: 1 })!
    const second = repository.claim({ workerId: 'w2', kinds: ['INVESTIGATE'], now: at(0), leaseMs: 10_000, maxActivePerTenant: 1 })!
    expect(first.tenantId).toBe('tenant-a')
    expect(second.jobId).toBe(other.jobId)
    expect(repository.requestCancel(first.jobId, at(1))?.status).toBe('LEASED')
    expect(repository.isCancellationRequested(first.jobId)).toBe(true)
    expect(repository.cancelLeased({ jobId: first.jobId, owner: 'w1', epoch: first.leaseEpoch }, at(1))).toBe(true)
    expect(repository.get(first.jobId)?.status).toBe('CANCELLED')
    const queued = repository.findByBusinessKey('INVESTIGATE', 'tenant-a', 'a2')!
    expect(repository.requestCancel(queued.jobId, at(1))?.status).toBe('CANCELLED')
    store.close()
  })

  it('moves exhausted jobs to manual review and runs retryable handlers through the worker', async () => {
    const store = new CommerceDatabase(databasePath())
    const repository = new DurableJobRepository(store)
    const job = repository.enqueue({
      kind: 'RECONCILE', tenantId: 'tenant-a', shopId: 'shop-a', businessKey: 'request-1',
      payload: {}, now: at(0), maxAttempts: 1,
    })
    const clock = { now: at(0) }
    const worker = new DurableWorker({
      repository, workerId: 'worker', leaseMs: 5_000, now: () => new Date(clock.now),
      handlers: { RECONCILE: async () => { throw new RetryableJobError('still unknown', 1_000) } },
    })
    expect(await worker.runOnce()).toBe(true)
    expect(repository.get(job.jobId)?.status).toBe('MANUAL_REVIEW')
    store.close()
  })

  it('commits a business job and outbox event atomically and delivers events idempotently', () => {
    const store = new CommerceDatabase(databasePath())
    const jobs = new DurableJobRepository(store)
    const outbox = new OutboxRepository(store)
    expect(() => jobs.transaction(() => {
      jobs.enqueue({ kind: 'EXECUTE', tenantId: 'tenant-a', shopId: 'shop-a', businessKey: 'proposal-rollback', payload: {}, now: at(0) })
      outbox.append({
        tenantId: 'tenant-a', shopId: 'shop-a', aggregateType: 'Proposal', aggregateId: 'proposal-rollback',
        eventType: 'PROPOSAL_APPROVED', idempotencyKey: 'proposal-rollback:approved', payload: {}, now: at(0),
      })
      throw new Error('rollback')
    })).toThrow('rollback')
    expect(jobs.findByBusinessKey('EXECUTE', 'tenant-a', 'proposal-rollback')).toBeUndefined()
    expect(store.database.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM commerce_outbox').get()?.count).toBe(0)

    jobs.transaction(() => {
      jobs.enqueue({ kind: 'EXECUTE', tenantId: 'tenant-a', shopId: 'shop-a', businessKey: 'proposal-commit', payload: {}, now: at(0) })
      outbox.append({
        tenantId: 'tenant-a', shopId: 'shop-a', aggregateType: 'Proposal', aggregateId: 'proposal-commit',
        eventType: 'PROPOSAL_APPROVED', idempotencyKey: 'proposal-commit:approved', payload: {}, now: at(0),
      })
    })
    const event = outbox.claim({ workerId: 'publisher-1', now: at(0), leaseMs: 1_000 })!
    expect(outbox.markPublished({ eventId: event.eventId, workerId: 'publisher-2', now: at(0) })).toBe(false)
    expect(outbox.markPublished({ eventId: event.eventId, workerId: 'publisher-1', now: at(0) })).toBe(true)
    expect(outbox.claim({ workerId: 'publisher-1', now: at(0), leaseMs: 1_000 })).toBeUndefined()
    store.close()
  })

  it('persists an investigation task, job, and outbox event in one transaction', async () => {
    const store = new CommerceDatabase(databasePath())
    const jobs = new DurableJobRepository(store)
    const outbox = new OutboxRepository(store)
    const task = createInvestigationTask(COMPLETE_INPUT, {
      principal: TEST_PRINCIPAL, asOf: at(0), fixtureDigest: 'digest-1', taskId: 'task-atomic',
      now: () => new Date(at(0)),
    })
    await new InvestigationRepository(store).createTask(
      task, TEST_BUDGET, () => createTaskJobSink(jobs, outbox)(task, at(0)),
    )
    expect(jobs.findByBusinessKey('INVESTIGATE', task.tenantId, `${task.taskId}:v1`)?.status).toBe('READY')
    expect(store.database.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM commerce_outbox').get()?.count).toBe(1)
    expect(store.database.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM investigation_tasks').get()?.count).toBe(1)
    store.close()
  })

  it('keeps unresolved tasks durable without inventing a shop-scoped queue identity', async () => {
    const store = new CommerceDatabase(databasePath())
    const jobs = new DurableJobRepository(store)
    const outbox = new OutboxRepository(store)
    const task = createInvestigationTask({ schemaVersion: 1, question: 'What changed?' }, {
      principal: TEST_PRINCIPAL, asOf: at(0), fixtureDigest: 'digest-1', taskId: 'task-unresolved',
      now: () => new Date(at(0)),
    })
    await new InvestigationRepository(store).createTask(
      task, TEST_BUDGET, () => createTaskJobSink(jobs, outbox)(task, at(0)),
    )
    expect(store.database.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM investigation_tasks').get()?.count).toBe(1)
    expect(store.database.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM commerce_jobs').get()?.count).toBe(0)
    expect(store.database.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM commerce_outbox').get()?.count).toBe(0)
    store.close()
  })
})
