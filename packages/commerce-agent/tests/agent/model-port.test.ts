import { describe, expect, it } from 'bun:test'
import { PiModelTurnPort } from '../../src/agent/drivers/pi-model-driver.ts'
import { FakeModelTurnPort, ZERO_USAGE, type ModelEvent } from '../../src/agent/model-port.ts'

const REQUEST = { systemPrompt: 'test', messages: [{ role: 'user' as const, content: 'question' }], tools: [], maxOutputTokens: 10 }

async function collect(iterable: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const events: ModelEvent[] = []
  for await (const event of iterable) events.push(event)
  return events
}

describe('T07-T10 model turn port', () => {
  it('T07 returns one standardized completed turn without executing tools', async () => {
    const port = new FakeModelTurnPort([{
      requestId: 'request-1', text: 'inspect', toolCalls: [{ callId: 'call-1', name: 'query_sales', arguments: { period: 'current' } }],
      stopReason: 'tool_use', usage: ZERO_USAGE,
    }])
    const events = await collect(port.generate(REQUEST, new AbortController().signal))
    expect(events.at(-1)?.type).toBe('turn_complete')
    expect(port.requests).toHaveLength(1)
  })

  it('T09 propagates cancellation before a fake request starts', async () => {
    const port = new FakeModelTurnPort([])
    const controller = new AbortController()
    controller.abort()
    const events = await collect(port.generate(REQUEST, controller.signal))
    expect(events).toEqual([{ type: 'turn_error', code: 'ABORTED', message: 'request aborted' }])
  })

  it('T10 fails closed when live credentials are unavailable', async () => {
    const envName = 'COMMERCE_TEST_MISSING_API_KEY'
    delete process.env[envName]
    const port = new PiModelTurnPort({ provider: 'openai', modelId: 'test-model', apiKeyEnv: envName })
    const events = await collect(port.generate(REQUEST, new AbortController().signal))
    expect(events[0]?.type).toBe('turn_error')
    expect(events[0]).toMatchObject({ code: 'PROVIDER_UNAVAILABLE' })
    expect(port.describe().mode).toBe('live')
  })
})
