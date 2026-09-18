import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'
import { createHash } from 'node:crypto'
import { AgentEvalCaseSchema, AgentEvalGoldSchema, type AgentEvalCase, type AgentEvalGold } from './schemas.ts'

async function jsonl<T>(path: string, schema: z.ZodType<T>): Promise<T[]> {
  const text = await readFile(path, 'utf8')
  return text.split('\n').filter(line => line.trim()).map((line, index) => {
    try { return schema.parse(JSON.parse(line)) } catch (error) {
      throw new Error(`Invalid JSONL record ${index + 1} in ${path}: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
}

export async function loadAgentEval(root = import.meta.dir): Promise<{
  cases: AgentEvalCase[]
  gold: AgentEvalGold[]
  splits: { dev: string[]; smoke: string[] }
  digest: string
}> {
  const [cases, gold, splitsValue] = await Promise.all([
    jsonl(resolve(root, 'cases/dev.jsonl'), AgentEvalCaseSchema),
    jsonl(resolve(root, 'gold/dev.jsonl'), AgentEvalGoldSchema),
    readFile(resolve(root, 'splits.json'), 'utf8').then(value => JSON.parse(value)),
  ])
  const splits = z.object({
    dev: z.array(z.string()).length(20), smoke: z.array(z.string()).length(5),
  }).strict().parse(splitsValue)
  const caseIds = cases.map(item => item.id)
  const goldIds = gold.map(item => item.id)
  if (new Set(caseIds).size !== cases.length || new Set(goldIds).size !== gold.length) throw new Error('Evaluation IDs must be unique')
  if (JSON.stringify([...caseIds].sort()) !== JSON.stringify([...goldIds].sort())) throw new Error('Case and gold IDs do not align')
  if (JSON.stringify([...caseIds].sort()) !== JSON.stringify([...splits.dev].sort())) throw new Error('Dev split does not contain all cases')
  if (splits.smoke.some(id => !caseIds.includes(id))) throw new Error('Smoke split contains an unknown ID')
  const digest = createHash('sha256').update(JSON.stringify({ cases, gold, splits })).digest('hex')
  return { cases, gold, splits, digest }
}
