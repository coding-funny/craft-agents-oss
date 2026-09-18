import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { loadAgentEval } from '../../evals/agent/dataset.ts'
import { gradePrediction } from '../../evals/agent/graders/deterministic.ts'

describe('T37-T39 agent development evaluation set', () => {
  it('T37 loads exactly 20 aligned cases with the planned category distribution and smoke split', async () => {
    const dataset = await loadAgentEval()
    expect(dataset.cases).toHaveLength(20)
    expect(Object.fromEntries(['normal', 'ads', 'commerce', 'uncertain', 'failure'].map(category => [
      category, dataset.cases.filter(item => item.category === category).length,
    ]))).toEqual({ normal: 3, ads: 5, commerce: 5, uncertain: 4, failure: 3 })
    expect(dataset.splits.smoke).toEqual(['normal-01', 'ads-01', 'commerce-01', 'uncertain-02', 'failure-01'])
  })

  it('T38 gives deterministic pass/fail with visible denominators', async () => {
    const dataset = await loadAgentEval()
    const gold = dataset.gold.find(item => item.id === 'ads-01')!
    const correct = gradePrediction({
      id: 'ads-01', status: 'REPORT_READY', evidenceTools: ['query_ads', 'query_inventory', 'query_promotions'],
      unknowns: [], claims: [], modelMode: 'fake',
    }, gold)
    expect(correct.passed).toBe(true)
    expect(correct.earned).toBe(correct.possible)
    const incorrect = gradePrediction({ id: 'ads-01', status: 'FAILED', evidenceTools: [], unknowns: [], claims: ['素材必然导致下降'], modelMode: 'fake' }, gold)
    expect(incorrect.passed).toBe(false)
    expect(incorrect.failures.length).toBeGreaterThan(0)
  })

  it('T39 keeps gold labels in a separate file from model-visible cases', async () => {
    const caseText = await readFile(resolve(import.meta.dir, '../../evals/agent/cases/dev.jsonl'), 'utf8')
    expect(caseText).not.toContain('expectedStatuses')
    expect(caseText).not.toContain('forbiddenClaims')
    expect(caseText).not.toContain('requiredEvidenceTools')
  })
})
