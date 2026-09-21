import { describe, expect, it } from 'bun:test'
import { createFixtureHarness, BASELINE_WINDOW, CURRENT_WINDOW, queryFor } from './helpers.ts'

describe('FixtureAdapter', () => {
  it('uses [start, end) and includes refund events from orders paid in an earlier window', async () => {
    const { adapter } = createFixtureHarness()
    const current = await adapter.querySales(queryFor(['SKU-A'], CURRENT_WINDOW))
    const ids = current.data.map(row => row.lineId)

    expect(ids).toContain('A-1')
    expect(ids).toContain('A-3')
    expect(ids).not.toContain('A-2')
    expect(ids).not.toContain('A-6')
    expect(current.data.find(row => row.lineId === 'A-3')?.paidAt).toBe(CURRENT_WINDOW.start)

    const baseline = await adapter.querySales(queryFor(['SKU-A'], BASELINE_WINDOW))
    expect(baseline.data.map(row => row.lineId)).toEqual(['A-1', 'A-2'])
  })

  it('preserves product-to-SKU mappings including sibling variants', async () => {
    const { adapter } = createFixtureHarness()
    const result = await adapter.queryProducts(queryFor(['SKU-A', 'SKU-B']))
    expect(result.data).toHaveLength(2)
    expect(new Set(result.data.map(row => row.productId))).toEqual(new Set(['P-TSHIRT']))
    expect(result.data.map(row => row.skuId).sort()).toEqual(['SKU-A', 'SKU-B'])
  })

  it('returns an evidenced missing result for a zero-sales SKU', async () => {
    const { adapter } = createFixtureHarness()
    const result = await adapter.querySales(queryFor(['SKU-Z']))
    expect(result.status).toBe('missing')
    expect(result.data).toEqual([])
    expect(result.evidence).toHaveLength(1)
    expect(result.evidence[0]?.locator).toBe('empty-result')
  })

  it('rejects shops and currencies outside the fixture scope', async () => {
    const { adapter } = createFixtureHarness()
    await expect(adapter.querySales({ ...queryFor(['SKU-A']), shopId: 'other-shop' })).rejects.toThrow(
      'outside the configured fixture scope',
    )
    await expect(adapter.querySales({ ...queryFor(['SKU-A']), currency: 'USD' })).rejects.toThrow(
      'only supports CNY',
    )
  })
})
