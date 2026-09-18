import { describe, expect, it } from 'bun:test'
import { BudgetLedger } from '../../src/agent/budget.ts'
import { CommerceError } from '../../src/domain/errors.ts'
import { TEST_BUDGET } from './helpers.ts'

describe('T17-T21 budget ledger', () => {
  it('T17 never lets reservations make the balance negative', () => {
    const ledger = new BudgetLedger({ ...TEST_BUDGET, maxToolCalls: 1 })
    ledger.reserveTools(1)
    expect(() => ledger.reserveTools(1)).toThrow(CommerceError)
    expect(ledger.snapshot().toolCalls).toBe(1)
  })

  it('T19 preserves unknown usage and enforces aggregate limits', () => {
    const ledger = new BudgetLedger(TEST_BUDGET)
    ledger.reserveModel()
    ledger.settleModel({
      inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0,
      costMicros: 5, source: 'unknown',
    })
    expect(ledger.snapshot().usage.source).toBe('unknown')
    expect(ledger.snapshot().usage.costMicros).toBe(5)
  })

  it('T20 rejects an oversized tool batch before mutating the ledger', () => {
    const ledger = new BudgetLedger({ ...TEST_BUDGET, maxToolCalls: 2 })
    expect(() => ledger.reserveTools(3)).toThrow(CommerceError)
    expect(ledger.snapshot().toolCalls).toBe(0)
  })
})
