import { describe, expect, it } from 'bun:test'
import { COMMERCE_TOOLS } from '../src/mcp/server.ts'
import { GetEvidenceInputSchema, QueryToolInputSchema } from '../src/mcp/schemas.ts'

const VALID_QUERY = {
  run_id: 'run-mcp-001',
  case_id: 'case-mcp-001',
  trace_id: 'trace-mcp-001',
  shop_id: 'demo-shop',
  sku_ids: ['SKU-A'],
  window: {
    start: '2026-09-08T00:00:00+08:00',
    end: '2026-09-15T00:00:00+08:00',
    timezone: 'Asia/Shanghai',
  },
  as_of: '2026-09-15T09:00:00+08:00',
  currency: 'CNY',
}

describe('MCP schemas and registry', () => {
  it('registers diagnosis and proposal tools without operator actions', () => {
    expect(COMMERCE_TOOLS.map(tool => tool.name)).toEqual([
      'query_sales',
      'query_inventory',
      'query_promotions',
      'compute_margin',
      'query_ads',
      'get_evidence',
      'validate_report',
      'create_proposal',
      'get_proposal',
    ])
    expect(COMMERCE_TOOLS.some(tool => /approve|reject|execute|update|write/i.test(tool.name))).toBe(false)
  })

  it('accepts a scoped query and defaults currency', () => {
    const { currency, ...withoutCurrency } = VALID_QUERY
    expect(currency).toBe('CNY')
    expect(QueryToolInputSchema.parse(withoutCurrency).currency).toBe('CNY')
  })

  it('rejects arbitrary paths, SQL, unknown fields, and empty SKU scopes', () => {
    expect(() => QueryToolInputSchema.parse({ ...VALID_QUERY, fixture_dir: '/tmp/private' })).toThrow()
    expect(() => QueryToolInputSchema.parse({ ...VALID_QUERY, sql: 'select * from orders' })).toThrow()
    expect(() => QueryToolInputSchema.parse({ ...VALID_QUERY, sku_ids: [] })).toThrow()
  })

  it('requires a well-formed evidence ID for evidence lookup', () => {
    expect(GetEvidenceInputSchema.parse({
      ...VALID_QUERY,
      evidence_id: 'ev_0123456789abcdef01234567',
    }).evidence_id).toBe('ev_0123456789abcdef01234567')
    expect(() => GetEvidenceInputSchema.parse({ ...VALID_QUERY, evidence_id: '../secret' })).toThrow()
  })
})
