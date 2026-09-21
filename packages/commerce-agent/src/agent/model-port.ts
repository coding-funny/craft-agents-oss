import type { UsageRecord } from '../contracts/runtime.ts'

export type ModelToolDefinition = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export type ModelMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: CompletedToolCall[] }
  | { role: 'tool'; toolCallId: string; toolName: string; content: string; isError: boolean }

export type CompletedToolCall = {
  callId: string
  name: string
  arguments: unknown
}

export type CompletedTurn = {
  requestId: string
  text: string
  toolCalls: CompletedToolCall[]
  stopReason: 'stop' | 'tool_use' | 'length'
  usage: UsageRecord
}

export type ModelTurnRequest = {
  systemPrompt: string
  messages: ModelMessage[]
  tools: ModelToolDefinition[]
  maxOutputTokens: number
}

export type ModelEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'turn_complete'; turn: CompletedTurn }
  | { type: 'turn_error'; code: string; message: string; usage?: UsageRecord }

export interface ModelTurnPort {
  describe(): {
    driver: string
    modelId: string
    modelVersion?: string
    mode: 'fake' | 'live'
    supportsTools: boolean
    supportsAbort: boolean
    usageMode: 'actual' | 'estimated' | 'unknown'
  }
  generate(request: ModelTurnRequest, signal: AbortSignal): AsyncIterable<ModelEvent>
  close(): Promise<void>
}

export class FakeModelTurnPort implements ModelTurnPort {
  readonly #turns: Array<CompletedTurn | { error: string }>
  requests: ModelTurnRequest[] = []

  constructor(turns: Array<CompletedTurn | { error: string }>) {
    this.#turns = [...turns]
  }

  describe() {
    return {
      driver: 'scripted-fake', modelId: 'fake-commerce-v1', mode: 'fake' as const,
      supportsTools: true, supportsAbort: true, usageMode: 'actual' as const,
    }
  }

  async *generate(request: ModelTurnRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    this.requests.push(structuredClone(request))
    if (signal.aborted) {
      yield { type: 'turn_error', code: 'ABORTED', message: 'request aborted' }
      return
    }
    const next = this.#turns.shift()
    if (!next) {
      yield { type: 'turn_error', code: 'SCRIPT_EXHAUSTED', message: 'fake model script exhausted' }
      return
    }
    if ('error' in next) {
      yield { type: 'turn_error', code: 'FAKE_ERROR', message: next.error }
      return
    }
    if (next.text) yield { type: 'text_delta', text: next.text }
    yield { type: 'turn_complete', turn: next }
  }

  async close(): Promise<void> {}
}

export const ZERO_USAGE: UsageRecord = {
  inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costMicros: 0, source: 'actual',
}
