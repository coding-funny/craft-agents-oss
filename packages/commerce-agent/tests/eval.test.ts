import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { runFailureInjection } from '../evals/failure-injection.ts'
import { loadDataset, runEvaluation } from '../evals/runner.ts'

const temporaryDirectories: string[] = []

function temp(prefix: string): string {
  const path = mkdtempSync(resolve(tmpdir(), prefix))
  temporaryDirectories.push(path)
  return path
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('commerce deterministic evaluation', () => {
  it('loads 16 dev and 8 holdout cases with unique IDs', async () => {
    const dataset = await loadDataset(resolve(import.meta.dir, '../evals/dataset.jsonl'))
    expect(dataset).toHaveLength(24)
    expect(dataset.filter(item => item.split === 'dev')).toHaveLength(16)
    expect(dataset.filter(item => item.split === 'holdout')).toHaveLength(8)
    expect(new Set(dataset.map(item => item.id)).size).toBe(24)
  })

  it('passes all deterministic cases and records honest limitations', async () => {
    const result = await runEvaluation({ outputDir: temp('commerce-eval-output-'), runtimeRoot: temp('commerce-eval-runtime-') })
    expect(result.report.datasetSize).toBe(24)
    expect(result.report.passed).toBe(24)
    expect(result.report.failed).toBe(0)
    expect(result.report.limitations.some(item => item.includes('No external LLM'))).toBe(true)
    expect(result.ablations).toHaveLength(6)
    expect(result.baselines).toHaveLength(2)
  })

  it('passes every structured failure-injection probe', async () => {
    const result = await runFailureInjection({ outputDir: temp('commerce-failure-output-'), runtimeRoot: temp('commerce-failure-runtime-') })
    expect(result.results).toHaveLength(11)
    expect(result.results.every(item => item.passed)).toBe(true)
  })
})
