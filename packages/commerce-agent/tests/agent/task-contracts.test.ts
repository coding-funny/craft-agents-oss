import { describe, expect, it } from 'bun:test'
import { createInvestigationTask, InvestigationInputSchema } from '../../src/contracts/task.ts'
import { CommerceError } from '../../src/domain/errors.ts'
import { COMPLETE_INPUT, TEST_PRINCIPAL } from './helpers.ts'

describe('T02-T04 task contracts', () => {
  it('T02 rejects blank questions, malformed dates and untrusted extra fields', () => {
    expect(() => InvestigationInputSchema.parse({ schemaVersion: 1, question: ' ' })).toThrow()
    expect(() => InvestigationInputSchema.parse({ ...COMPLETE_INPUT, actorId: 'attacker' })).toThrow()
    expect(() => InvestigationInputSchema.parse({
      ...COMPLETE_INPUT,
      scope: { ...COMPLETE_INPUT.scope, currentWindow: { start: 'not-a-date', end: 'also-bad', timezone: 'UTC' } },
    })).toThrow()
  })

  it('T03 creates a task without resolved scope when clarification is required', () => {
    const task = createInvestigationTask({ schemaVersion: 1, question: 'What changed?' }, {
      principal: TEST_PRINCIPAL, asOf: '2026-09-15T09:00:00+08:00', fixtureDigest: 'digest', taskId: 'task-missing',
    })
    expect(task.resolvedScope).toBeUndefined()
  })

  it('T04 rejects a shop outside the trusted principal scope', () => {
    try {
      createInvestigationTask({ ...COMPLETE_INPUT, scope: { ...COMPLETE_INPUT.scope, shopId: 'other-shop' } }, {
        principal: TEST_PRINCIPAL, asOf: '2026-09-15T09:00:00+08:00', fixtureDigest: 'digest',
      })
      throw new Error('expected scope denial')
    } catch (error) {
      expect(error).toBeInstanceOf(CommerceError)
      expect((error as CommerceError).code).toBe('SCOPE_DENIED')
    }
  })
})
