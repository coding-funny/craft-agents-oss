import { randomUUID } from 'node:crypto'
import { completeSimple, getModel } from '@earendil-works/pi-ai/compat'
import type { AssistantMessage, Context, Message, Tool } from '@earendil-works/pi-ai'
import { CommerceError } from '../../domain/errors.ts'
import type { CompletedTurn, ModelEvent, ModelMessage, ModelTurnPort, ModelTurnRequest } from '../model-port.ts'

export type PiModelDriverConfig = {
  provider: string
  modelId: string
  apiKeyEnv: string
  timeoutMs?: number
  maxRetries?: number
}

function messageToPi(message: ModelMessage): Message {
  const timestamp = Date.now()
  if (message.role === 'user') return { role: 'user', content: message.content, timestamp }
  if (message.role === 'assistant') {
    return {
      role: 'assistant', api: 'openai-responses', provider: 'openai', model: 'replayed-commerce-turn',
      content: [
        ...(message.content ? [{ type: 'text' as const, text: message.content }] : []),
        ...(message.toolCalls ?? []).map(call => ({ type: 'toolCall' as const, id: call.callId, name: call.name, arguments: call.arguments as Record<string, unknown> })),
      ],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: (message.toolCalls?.length ?? 0) > 0 ? 'toolUse' : 'stop', timestamp,
    }
  }
  return {
    role: 'toolResult', toolCallId: message.toolCallId, toolName: message.toolName,
    content: [{ type: 'text', text: message.content }], isError: message.isError, timestamp,
  }
}

function toCompletedTurn(message: AssistantMessage): CompletedTurn {
  const text = message.content.filter(part => part.type === 'text').map(part => part.text).join('')
  const toolCalls = message.content.filter(part => part.type === 'toolCall').map(part => ({
    callId: part.id, name: part.name, arguments: part.arguments,
  }))
  return {
    requestId: message.responseId ?? `request_${randomUUID()}`,
    text,
    toolCalls,
    stopReason: message.stopReason === 'toolUse' ? 'tool_use' : message.stopReason === 'length' ? 'length' : 'stop',
    usage: {
      inputTokens: message.usage.input,
      outputTokens: message.usage.output,
      cacheReadTokens: message.usage.cacheRead,
      cacheWriteTokens: message.usage.cacheWrite,
      reasoningTokens: message.usage.reasoning,
      costMicros: Math.max(0, Math.ceil(message.usage.cost.total * 1_000_000)),
      source: 'actual',
    },
  }
}

export class PiModelTurnPort implements ModelTurnPort {
  readonly #config: PiModelDriverConfig

  constructor(config: PiModelDriverConfig) { this.#config = config }

  describe() {
    return {
      driver: 'pi-ai-complete-simple', modelId: `${this.#config.provider}/${this.#config.modelId}`,
      mode: 'live' as const, supportsTools: true, supportsAbort: true, usageMode: 'actual' as const,
    }
  }

  async *generate(request: ModelTurnRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    const apiKey = process.env[this.#config.apiKeyEnv]
    if (!apiKey) {
      yield { type: 'turn_error', code: 'PROVIDER_UNAVAILABLE', message: `Configured API-key environment variable is unavailable: ${this.#config.apiKeyEnv}` }
      return
    }
    const model = getModel(this.#config.provider as never, this.#config.modelId as never)
    if (!model) {
      yield { type: 'turn_error', code: 'PROVIDER_UNAVAILABLE', message: `Unknown model: ${this.#config.provider}/${this.#config.modelId}` }
      return
    }
    const context: Context = {
      systemPrompt: request.systemPrompt,
      messages: request.messages.map(messageToPi),
      tools: request.tools.map(tool => ({
        name: tool.name, description: tool.description, parameters: tool.inputSchema,
      }) as unknown as Tool),
    }
    try {
      const result = await completeSimple(model, context, {
        apiKey, signal, maxTokens: request.maxOutputTokens,
        timeoutMs: this.#config.timeoutMs ?? 60_000,
        maxRetries: this.#config.maxRetries ?? 0,
      })
      yield { type: 'turn_complete', turn: toCompletedTurn(result) }
    } catch (error) {
      if (signal.aborted) {
        yield { type: 'turn_error', code: 'ABORTED', message: 'model request aborted' }
        return
      }
      const normalized = error instanceof Error ? error.message : String(error)
      yield { type: 'turn_error', code: 'PROVIDER_UNAVAILABLE', message: normalized.slice(0, 500) }
    }
  }

  async close(): Promise<void> {}
}

export function assertPiDriverConfigured(config: PiModelDriverConfig): void {
  if (!config.apiKeyEnv.trim()) throw new CommerceError('INVALID_ARGUMENT', 'apiKeyEnv is required for live model mode')
}
