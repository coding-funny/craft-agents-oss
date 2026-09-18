import { describe, expect, it } from 'bun:test'
import { EvidenceRepository } from '../src/evidence/evidence-repository.ts'
import { createFixtureHarness, queryFor } from './helpers.ts'

describe('EvidenceRepository', () => {
  it('generates a stable evidence ID when only run and trace correlation changes', async () => {
    const { adapter, evidence } = createFixtureHarness()
    const first = await adapter.querySales(queryFor(['SKU-A'], undefined, 'trace-first'))
    const secondQuery = {
      ...queryFor(['SKU-A'], undefined, 'trace-second'),
      runId: 'run-test-002',
      caseId: 'case-test-002',
    }
    const second = await adapter.querySales(secondQuery)

    expect(first.evidence[0]?.evidenceId).toBe(second.evidence[0]?.evidenceId)
    expect(first.evidence[0]?.traceId).toBe('trace-first')
    expect(second.evidence[0]?.traceId).toBe('trace-second')
    expect(evidence.list()).toHaveLength(1)
  })

  it('changes the evidence ID when the substantive query changes', async () => {
    const { adapter } = createFixtureHarness()
    const skuA = await adapter.querySales(queryFor(['SKU-A']))
    const skuB = await adapter.querySales(queryFor(['SKU-B']))
    expect(skuA.evidence[0]?.evidenceId).not.toBe(skuB.evidence[0]?.evidenceId)
  })

  it('retrieves details and rejects unknown IDs', () => {
    const repository = new EvidenceRepository()
    const ref = repository.capture({
      tool: 'query_test',
      source: 'fixture/test.json',
      asOf: '2026-09-15T09:00:00+08:00',
      traceId: 'trace-test',
      query: { skuId: 'SKU-A' },
      recordRefs: ['record-1'],
      content: [{ value: 1 }],
      summary: 'test evidence',
    })
    expect(repository.getOrThrow(ref.evidenceId).recordRefs).toEqual(['record-1'])
    expect(() => repository.getOrThrow('ev_000000000000000000000000')).toThrow('Evidence not found')
  })
})
