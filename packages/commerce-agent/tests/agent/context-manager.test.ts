import { describe, expect, it } from 'bun:test'
import { buildContext } from '../../src/agent/context-manager.ts'
import type { ModelMessage } from '../../src/agent/model-port.ts'

describe('T22 context compaction', () => {
  it('retains counter-evidence, constraints and evidence references', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'x'.repeat(2_000) },
      { role: 'assistant', content: '', toolCalls: [{ callId: 'call-1', name: 'query_sales', arguments: { period: 'baseline' } }] },
      { role: 'tool', toolCallId: 'call-1', toolName: 'query_sales', content: 'y'.repeat(2_000), isError: false },
      { role: 'user', content: 'continue' },
    ]
    const compacted = buildContext(messages, {
      pendingSteps: ['check inventory'], facts: [], hypotheses: [],
      counterEvidence: [{ statement: 'Inventory remained available', evidenceIds: ['ev_0123456789abcdef01234567'] }],
      missingData: ['attribution maturity'], evidenceIds: ['ev_0123456789abcdef01234567'], toolHistory: [],
    }, 600)
    const serialized = JSON.stringify(compacted)
    expect(serialized).toContain('Inventory remained available')
    expect(serialized).toContain('ev_0123456789abcdef01234567')
    expect(serialized).toContain('attribution maturity')
  })
})
