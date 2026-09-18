import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { z } from 'zod'
import { BudgetConfigSchema, type BudgetConfig } from '../contracts/runtime.ts'
import { PrincipalContextSchema, type PrincipalContext } from '../contracts/task.ts'
import { CommerceError } from '../domain/errors.ts'

const FakeModelConfigSchema = z.object({
  mode: z.literal('fake'),
  scriptPath: z.string().min(1),
}).strict()

const LiveModelConfigSchema = z.object({
  mode: z.literal('live'),
  provider: z.string().min(1),
  modelId: z.string().min(1),
  apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  timeoutMs: z.number().int().min(100).max(300_000).default(60_000),
}).strict()

export const InvestigationConfigSchema = z.object({
  schemaVersion: z.literal(1),
  dataMode: z.literal('fixture'),
  model: z.discriminatedUnion('mode', [FakeModelConfigSchema, LiveModelConfigSchema]),
  principal: PrincipalContextSchema,
  fixtureDir: z.string().min(1),
  dbPath: z.string().min(1),
  reportDir: z.string().min(1),
  traceFile: z.string().min(1).optional(),
  asOf: z.iso.datetime({ offset: true }),
  budget: BudgetConfigSchema,
}).strict()

export type InvestigationConfig = Omit<z.infer<typeof InvestigationConfigSchema>, 'budget' | 'principal'> & {
  budget: BudgetConfig
  principal: PrincipalContext
}

function absolute(base: string, value: string): string {
  return resolve(base, value)
}

export async function loadInvestigationConfig(path: string): Promise<InvestigationConfig> {
  const configPath = resolve(path)
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(configPath, 'utf8'))
  } catch (error) {
    throw new CommerceError('INVALID_ARGUMENT', `Cannot read investigation config: ${error instanceof Error ? error.message : String(error)}`)
  }
  const parsed = InvestigationConfigSchema.parse(raw)
  const base = dirname(configPath)
  return {
    ...parsed,
    fixtureDir: absolute(base, parsed.fixtureDir),
    dbPath: absolute(base, parsed.dbPath),
    reportDir: absolute(base, parsed.reportDir),
    traceFile: parsed.traceFile ? absolute(base, parsed.traceFile) : undefined,
    model: parsed.model.mode === 'fake'
      ? { ...parsed.model, scriptPath: absolute(base, parsed.model.scriptPath) }
      : parsed.model,
  }
}

export async function fixtureDigest(fixtureDir: string): Promise<string> {
  const hash = createHash('sha256')
  for (const name of ['sales.json', 'inventory.json', 'promotions.json', 'ads.json', 'products.json']) {
    hash.update(name)
    hash.update(await readFile(resolve(fixtureDir, name)))
  }
  return hash.digest('hex')
}
