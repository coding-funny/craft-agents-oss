import { describe, expect, it } from 'bun:test'
import { createInvestigationTask } from '../../src/contracts/task.ts'
import { CommerceDatabase } from '../../src/storage/database.ts'
import { InvestigationRepository } from '../../src/storage/investigation-repository.ts'
import { COMPLETE_INPUT, TEST_BUDGET, TEST_PRINCIPAL } from './helpers.ts'

describe('T05/T28 investigation repository', () => {
  it('persists task, run and ordered events while keeping terminal state immutable', async () => {
    const store = new CommerceDatabase(':memory:')
    try {
      const repository = new InvestigationRepository(store)
      const task = createInvestigationTask(COMPLETE_INPUT, {
        principal: TEST_PRINCIPAL, asOf: '2026-09-15T09:00:00+08:00', fixtureDigest: 'fixture-test', taskId: 'task-repository',
      })
      await repository.createTask(task, TEST_BUDGET)
      const queued = await repository.createRun(task.taskId, { now: task.createdAt })
      const running = await repository.transition({
        runId: queued.runId, expected: 'QUEUED', status: 'RUNNING', now: task.createdAt, eventType: 'RUN_STARTED',
      })
      const failed = await repository.transition({
        runId: running.runId, expected: 'RUNNING', status: 'FAILED', now: task.createdAt,
        eventType: 'RUN_COMPLETED', completionReason: 'test failure',
      })
      expect(failed.status).toBe('FAILED')
      await expect(repository.transition({
        runId: failed.runId, expected: 'FAILED', status: 'RUNNING', now: task.createdAt, eventType: 'INVALID',
      })).rejects.toThrow('Invalid investigation run transition')
      expect((await repository.getRun(failed.runId)).status).toBe('FAILED')
      expect(repository.listEvents(failed.runId).map(event => event.type)).toEqual(['RUN_CREATED', 'RUN_STARTED', 'RUN_COMPLETED'])
    } finally {
      store.close()
    }
  })

  it('T06 rolls back a state update when its event cannot be serialized', async () => {
    const store = new CommerceDatabase(':memory:')
    try {
      const repository = new InvestigationRepository(store)
      const task = createInvestigationTask(COMPLETE_INPUT, {
        principal: TEST_PRINCIPAL, asOf: '2026-09-15T09:00:00+08:00', fixtureDigest: 'fixture-test', taskId: 'task-rollback',
      })
      await repository.createTask(task, TEST_BUDGET)
      const queued = await repository.createRun(task.taskId, { now: task.createdAt })
      await repository.transition({ runId: queued.runId, expected: 'QUEUED', status: 'RUNNING', now: task.createdAt, eventType: 'RUN_STARTED' })
      await expect(repository.transition({
        runId: queued.runId, expected: 'RUNNING', status: 'FAILED', now: task.createdAt,
        eventType: 'RUN_COMPLETED', payload: { unserializable: 1n },
      })).rejects.toThrow('Failed to transition')
      expect((await repository.getRun(queued.runId)).status).toBe('RUNNING')
      expect(repository.listEvents(queued.runId).map(event => event.type)).toEqual(['RUN_CREATED', 'RUN_STARTED'])
    } finally { store.close() }
  })
})
