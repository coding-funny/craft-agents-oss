import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { FakeModelTurnPort, type ModelTurnPort } from '../agent/model-port.ts'
import { PiModelTurnPort } from '../agent/drivers/pi-model-driver.ts'
import type { InvestigationConfig } from '../config/investigation.ts'
import { CommerceError } from '../domain/errors.ts'

const UsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative().optional(),
  costMicros: z.number().int().nonnegative(),
  source: z.enum(['actual', 'estimated', 'unknown']),
}).strict()

const FakeTurnSchema = z.object({
  requestId: z.string().min(1),
  text: z.string(),
  toolCalls: z.array(z.object({
    callId: z.string().min(1), name: z.string().min(1), arguments: z.unknown(),
  }).strict()),
  stopReason: z.enum(['stop', 'tool_use', 'length']),
  usage: UsageSchema,
}).strict()

const FakeScriptSchema = z.array(z.union([FakeTurnSchema, z.object({ error: z.string().min(1) }).strict()])).min(1)

export async function createConfiguredModel(config: InvestigationConfig): Promise<ModelTurnPort> {
  if (config.model.mode === 'fake') {
    const raw = JSON.parse(await readFile(config.model.scriptPath, 'utf8'))
    return new FakeModelTurnPort(FakeScriptSchema.parse(raw))
  }
  if (!process.env[config.model.apiKeyEnv]) {
    throw new CommerceError('PROVIDER_UNAVAILABLE', `Configured API-key environment variable is unavailable: ${config.model.apiKeyEnv}`)
  }
  return new PiModelTurnPort({
    provider: config.model.provider,
    modelId: config.model.modelId,
    apiKeyEnv: config.model.apiKeyEnv,
    timeoutMs: config.model.timeoutMs,
    maxRetries: 0,
  })
}
