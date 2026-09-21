import { describe, expect, it } from 'bun:test'
import { validateDevelopmentDataset } from '../../evals/agent/validate.ts'
import { RunUsageSchema } from '../../evals/agent/schemas.ts'

describe('evaluation dataset and evidence honesty', () => {
  it('validates the 20-case development seed while declaring release blockers', async () => {
    const first = await validateDevelopmentDataset()
    const second = await validateDevelopmentDataset()
    expect(first.status).toBe('development_seed_ready')
    expect(first.devCases).toBe(20)
    expect(first.smokeCases).toBe(5)
    expect(first.datasetDigest).toBe(second.datasetDigest)
    expect(first.releaseBlockers).toHaveLength(3)
    expect(first.releaseBlockers.join(' ')).toContain('No live-model')
  })

  it('does not encode unknown usage as zero cost', () => {
    expect(RunUsageSchema.safeParse({
      inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0,
      costMicros: 0, source: 'unknown',
    }).success).toBe(false)
    expect(RunUsageSchema.safeParse({
      inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0,
      source: 'unknown',
    }).success).toBe(true)
  })
})
