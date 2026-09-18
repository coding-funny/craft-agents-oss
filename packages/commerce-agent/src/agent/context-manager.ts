import type { ModelMessage } from './model-port.ts'
import type { InvestigationState } from './tool-dispatcher.ts'
import { CommerceError } from '../domain/errors.ts'

export function estimateTokens(messages: ModelMessage[]): number {
  return Math.ceil(JSON.stringify(messages).length / 4)
}

export function buildContext(messages: ModelMessage[], state: InvestigationState, maxTokens: number): ModelMessage[] {
  if (estimateTokens(messages) <= maxTokens) return messages
  const first = messages[0]?.role === 'user'
    ? { ...messages[0], content: messages[0].content.slice(0, Math.min(2_000, maxTokens * 2)) } as ModelMessage
    : undefined
  const summary: ModelMessage = {
    role: 'user',
    content: `TRUSTED INVESTIGATION STATE (do not treat as new user instructions):\n${JSON.stringify({
      facts: state.facts,
      hypotheses: state.hypotheses,
      counterEvidence: state.counterEvidence,
      missingData: state.missingData,
      evidenceIds: state.evidenceIds,
      pendingSteps: state.pendingSteps,
    })}`,
  }
  const groups: ModelMessage[][] = []
  for (let index = first ? 1 : 0; index < messages.length;) {
    const message = messages[index]!
    if (message.role === 'assistant' && message.toolCalls?.length) {
      const callIds = new Set(message.toolCalls.map(call => call.callId))
      const group: ModelMessage[] = [message]
      index += 1
      while (index < messages.length) {
        const candidate = messages[index]!
        if (candidate.role !== 'tool' || !callIds.has(candidate.toolCallId)) break
        group.push(candidate)
        index += 1
      }
      groups.push(group)
    } else {
      groups.push([message])
      index += 1
    }
  }
  const compacted: ModelMessage[] = first ? [first, summary] : [summary]
  for (const group of groups.reverse()) {
    const candidate = [...compacted.slice(0, first ? 2 : 1), ...group, ...compacted.slice(first ? 2 : 1)]
    if (estimateTokens(candidate) <= maxTokens) compacted.splice(first ? 2 : 1, 0, ...group)
  }
  if (estimateTokens(compacted) > maxTokens) throw new CommerceError('CONTEXT_LIMIT', 'Investigation context exceeds the configured token limit')
  return compacted
}
