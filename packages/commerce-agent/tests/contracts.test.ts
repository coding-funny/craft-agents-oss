import { describe, expect, it } from 'bun:test'
import {
  MoneySchema,
  ProductRefSchema,
  QueryContextSchema,
  SalesRecordSchema,
  TimeRangeSchema,
} from '../src/domain/contracts.ts'
import { CURRENT_WINDOW, queryFor } from './helpers.ts'

describe('commerce domain contracts', () => {
  it('accepts an offset-aware half-open time range', () => {
    expect(TimeRangeSchema.parse(CURRENT_WINDOW)).toEqual(CURRENT_WINDOW)
  })

  it('rejects missing offsets and non-positive ranges', () => {
    expect(() => TimeRangeSchema.parse({
      start: '2026-09-08T00:00:00',
      end: '2026-09-15T00:00:00',
      timezone: 'Asia/Shanghai',
    })).toThrow()
    expect(() => TimeRangeSchema.parse({
      start: '2026-09-15T00:00:00+08:00',
      end: '2026-09-08T00:00:00+08:00',
      timezone: 'Asia/Shanghai',
    })).toThrow('start must be before end')
  })

  it('rejects invalid IANA timezones', () => {
    expect(() => TimeRangeSchema.parse({
      ...CURRENT_WINDOW,
      timezone: 'Mars/Olympus',
    })).toThrow('must be a valid IANA timezone')
  })

  it('requires safe integer minor units', () => {
    expect(MoneySchema.parse({ amountMinor: 12345, currency: 'CNY' })).toEqual({
      amountMinor: 12345,
      currency: 'CNY',
    })
    expect(() => MoneySchema.parse({ amountMinor: 12.34, currency: 'CNY' })).toThrow()
    expect(() => MoneySchema.parse({ amountMinor: Number.MAX_SAFE_INTEGER + 1, currency: 'CNY' })).toThrow()
  })

  it('keeps product and SKU identity explicit', () => {
    const product = ProductRefSchema.parse({
      shopId: 'demo-shop',
      productId: 'P-TSHIRT',
      skuId: 'SKU-A',
      spec: 'red-M',
      currency: 'CNY',
    })
    expect(product.productId).toBe('P-TSHIRT')
    expect(product.skuId).toBe('SKU-A')
  })

  it('rejects records with missing business fields instead of defaulting them to zero', () => {
    expect(() => SalesRecordSchema.parse({
      lineId: 'line-1',
      orderId: 'order-1',
      shopId: 'demo-shop',
      productId: 'P-1',
      skuId: 'SKU-1',
      paidAt: '2026-09-09T00:00:00+08:00',
      paidAmountMinor: 100,
      currency: 'CNY',
      status: 'PAID',
      refunds: [],
    })).toThrow()
  })

  it('validates complete query context', () => {
    expect(QueryContextSchema.parse(queryFor(['SKU-A'])).skuIds).toEqual(['SKU-A'])
    expect(() => QueryContextSchema.parse({ ...queryFor(['SKU-A']), skuIds: [] })).toThrow()
  })
})
