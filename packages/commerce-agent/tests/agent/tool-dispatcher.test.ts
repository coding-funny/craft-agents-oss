import { describe, expect, it } from 'bun:test'
import { buildStdioEnvironment } from '@craft-agent/shared/mcp'
import { BudgetLedger } from '../../src/agent/budget.ts'
import type { McpToolClient, TrustedRunContext } from '../../src/agent/tool-dispatcher.ts'
import { ScopedToolDispatcher } from '../../src/agent/tool-dispatcher.ts'
import { CommerceError } from '../../src/domain/errors.ts'
import { BASELINE_WINDOW, CURRENT_WINDOW } from '../helpers.ts'
import { TEST_BUDGET } from './helpers.ts'

const DOMAIN_TOOLS = ['query_sales', 'query_inventory', 'query_promotions', 'compute_margin', 'query_ads', 'get_evidence', 'validate_report']

class RecordingClient implements McpToolClient {
  calls: Array<{ name: string; args: Record<string, unknown> }> = []
  async listTools() { return [...DOMAIN_TOOLS, 'shell', 'approve', 'execute'].map(name => ({ name })) }
  async callTool(name: string, args: Record<string, unknown>) {
    this.calls.push({ name, args })
    return { content: [{ type: 'text', text: JSON.stringify({ status: 'ok', data: {}, evidence: [] }) }] }
  }
  async close() {}
}

function context(): TrustedRunContext {
  return {
    runId: 'run-test', taskId: 'task-test', traceId: 'trace-test', asOf: '2026-09-15T09:00:00+08:00',
    scope: { shopId: 'demo-shop', skuIds: ['SKU-A'], baselineWindow: BASELINE_WINDOW, currentWindow: CURRENT_WINDOW, currency: 'CNY' },
    signal: new AbortController().signal, toolTimeoutMs: 1_000,
  }
}

describe('T11-T15 scoped tool dispatcher', () => {
  it('T11 exposes only the model allowlist and rejects direct dangerous calls', async () => {
    const client = new RecordingClient()
    const dispatcher = new ScopedToolDispatcher({ client, budget: new BudgetLedger(TEST_BUDGET) })
    await dispatcher.initialize()
    expect(dispatcher.definitions().map(item => item.name)).not.toContain('shell')
    expect(() => dispatcher.preflight([{ callId: 'bad', name: 'shell', arguments: {} }], context())).toThrow(CommerceError)
    expect(client.calls).toHaveLength(0)
  })

  it('T12 rejects a mixed validate/query batch before any dispatch', async () => {
    const client = new RecordingClient()
    const dispatcher = new ScopedToolDispatcher({ client, budget: new BudgetLedger(TEST_BUDGET) })
    await dispatcher.initialize()
    expect(() => dispatcher.preflight([
      { callId: 'query', name: 'query_sales', arguments: { period: 'current' } },
      { callId: 'report', name: 'validate_report', arguments: { report: {} } },
    ], context())).toThrow(CommerceError)
    expect(client.calls).toHaveLength(0)
  })

  it('T13 rejects reserved scope fields and injects trusted scope for valid calls', async () => {
    const client = new RecordingClient()
    const dispatcher = new ScopedToolDispatcher({ client, budget: new BudgetLedger(TEST_BUDGET) })
    await dispatcher.initialize()
    expect(() => dispatcher.preflight([{
      callId: 'forged', name: 'query_sales', arguments: { period: 'current', shop_id: 'other-shop' },
    }], context())).toThrow(CommerceError)
    const call = { callId: 'ok', name: 'query_sales', arguments: { period: 'current', sku_ids: ['SKU-A'] } }
    dispatcher.preflight([call], context())
    await dispatcher.dispatch(call, context())
    expect(client.calls[0]?.args.shop_id).toBe('demo-shop')
    expect(client.calls[0]?.args.run_id).toBe('run-test')
  })

  it('T14 rejects evidence IDs that were not produced in the current task', async () => {
    const client = new RecordingClient()
    const dispatcher = new ScopedToolDispatcher({ client, budget: new BudgetLedger(TEST_BUDGET) })
    await dispatcher.initialize()
    const call = { callId: 'foreign', name: 'get_evidence', arguments: { evidence_id: 'ev_0123456789abcdef01234567' } }
    dispatcher.preflight([call], context())
    await expect(dispatcher.dispatch(call, context())).rejects.toThrow('outside this task')
    expect(client.calls).toHaveLength(0)
  })

  it('T15 does not inherit parent secrets when allowlist mode is selected', () => {
    const env = buildStdioEnvironment({ COMMERCE_MODE: 'readonly' }, false, {
      OPENAI_API_KEY: 'secret-value', RANDOM_SECRET: 'also-secret', PATH: '/bin',
    })
    expect(env).toEqual({ COMMERCE_MODE: 'readonly' })
    expect(JSON.stringify(env)).not.toContain('secret-value')
  })

  it('T18 settles physical MCP retry attempts from the tool envelope', async () => {
    const client = new RecordingClient()
    client.callTool = async (name: string, args: Record<string, unknown>) => {
      client.calls.push({ name, args })
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'ok', data: {}, evidence: [], attempts: 2 }) }] }
    }
    const ledger = new BudgetLedger(TEST_BUDGET)
    const dispatcher = new ScopedToolDispatcher({ client, budget: ledger })
    await dispatcher.initialize()
    const call = { callId: 'retry', name: 'query_sales', arguments: { period: 'current' } }
    dispatcher.preflight([call], context())
    await dispatcher.dispatch(call, context())
    expect(ledger.snapshot().toolCalls).toBe(1)
    expect(ledger.snapshot().toolAttempts).toBe(2)
  })
})
