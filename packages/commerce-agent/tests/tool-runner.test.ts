import { describe, expect, it } from 'bun:test'
import type { ToolEnvelope } from '../src/domain/contracts.ts'
import { CommerceError } from '../src/domain/errors.ts'
import { ToolRunner } from '../src/mcp/tool-runner.ts'
import { MemoryTraceRecorder } from '../src/mcp/trace.ts'
import { queryFor } from './helpers.ts'

const EVIDENCE = {
  evidenceId: 'ev_0123456789abcdef01234567',
  source: 'fixture-v1/test.json',
  locator: 'row-1',
  traceId: 'trace-runner',
}

function envelope(data: unknown, traceId = 'trace-runner'): ToolEnvelope<unknown> {
  return {
    status: 'ok',
    data,
    source: 'fixture-v1/test.json',
    asOf: '2026-09-15T09:00:00+08:00',
    query: queryFor(['SKU-A'], undefined, traceId),
    traceId,
    evidence: [{ ...EVIDENCE, traceId }],
    warnings: [],
  }
}

describe('ToolRunner', () => {
  it('retries a rate limit once and then succeeds under the retry budget', async () => {
    let attempts = 0
    const waits: number[] = []
    const traces = new MemoryTraceRecorder()
    const runner = new ToolRunner({
      baseDelayMs: 2,
      retryBudgetMs: 100,
      random: () => 0.5,
      sleep: async ms => { waits.push(ms) },
      traceRecorder: traces,
    })
    const result = await runner.execute('query_sales', { trace_id: 'trace-retry' }, async () => {
      attempts++
      if (attempts === 1) throw new CommerceError('RATE_LIMITED', 'retry later')
      return envelope({ ok: true }, 'trace-retry')
    })

    expect(result.data).toEqual({ ok: true })
    expect(result.attempts).toBe(2)
    expect(attempts).toBe(2)
    expect(waits).toEqual([2])
    expect(traces.records.map(record => record.status)).toEqual(['retrying', 'succeeded'])
  })

  it('stops sustained rate limits when the total retry budget is exhausted', async () => {
    let clock = 0
    let attempts = 0
    const runner = new ToolRunner({
      maxAttempts: 5,
      baseDelayMs: 2,
      retryBudgetMs: 5,
      random: () => 0.5,
      now: () => clock,
      sleep: async ms => { clock += ms },
    })
    await expect(runner.execute('query_sales', {}, async () => {
      attempts++
      clock += 1
      throw new CommerceError('RATE_LIMITED', 'still limited')
    })).rejects.toMatchObject({ code: 'RATE_LIMITED' })
    expect(attempts).toBe(2)
  })

  it('does not retry permanent validation failures', async () => {
    let attempts = 0
    const runner = new ToolRunner({ maxAttempts: 5, sleep: async () => {} })
    await expect(runner.execute('query_sales', {}, async () => {
      attempts++
      throw new CommerceError('INVALID_ARGUMENT', 'bad window')
    })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(attempts).toBe(1)
  })

  it('aborts a timed-out handler and returns a stable timeout error', async () => {
    const runner = new ToolRunner({ timeoutMs: 5, maxAttempts: 1 })
    await expect(runner.execute('query_sales', {}, async (_args, context) => await new Promise<ToolEnvelope<unknown>>((_resolve, reject) => {
      context.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    }))).rejects.toMatchObject({ code: 'UPSTREAM_TIMEOUT' })
  })

  it('truncates large output while preserving evidence references', async () => {
    const runner = new ToolRunner({ maxResultBytes: 500 })
    const result = await runner.execute('query_sales', {}, async (_args, context) => envelope({
      rows: Array.from({ length: 100 }, (_, index) => ({ index, value: 'x'.repeat(40) })),
    }, context.traceId))
    expect(result.truncated).toBe(true)
    expect(result.originalBytes).toBeGreaterThan(500)
    expect(result.evidence[0]?.evidenceId).toBe(EVIDENCE.evidenceId)
    expect(result.warnings[0]).toContain('use evidence IDs')
  })

  it('inherits the caller trace and redacts secrets in trace summaries', async () => {
    const traces = new MemoryTraceRecorder()
    const runner = new ToolRunner({ traceRecorder: traces })
    await runner.execute('query_sales', {
      trace_id: 'trace-parent',
      api_token: 'super-secret-token',
    }, async (_args, context) => envelope({ ok: true }, context.traceId))

    expect(traces.records[0]?.traceId).toBe('trace-parent')
    expect(JSON.stringify(traces.records[0]?.argumentSummary)).not.toContain('super-secret-token')
    expect(JSON.stringify(traces.records[0]?.argumentSummary)).toContain('[REDACTED]')
  })
})
