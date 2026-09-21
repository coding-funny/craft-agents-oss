import { describe, expect, it } from 'bun:test'
import { assertRunTransition } from '../../src/agent/state-machine.ts'
import { CommerceError } from '../../src/domain/errors.ts'

describe('T05 run state machine', () => {
  it('allows the normal path and rejects terminal reversal', () => {
    expect(() => assertRunTransition('QUEUED', 'RUNNING')).not.toThrow()
    expect(() => assertRunTransition('RUNNING', 'REPORT_READY')).not.toThrow()
    try {
      assertRunTransition('REPORT_READY', 'RUNNING')
      throw new Error('expected transition rejection')
    } catch (error) {
      expect((error as CommerceError).code).toBe('INVALID_ARGUMENT')
    }
  })
})
