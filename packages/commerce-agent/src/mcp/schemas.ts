import { z } from 'zod'
import {
  CurrencySchema,
  IdentifierSchema,
  IsoDateTimeSchema,
  TimeRangeSchema,
  type QueryContext,
} from '../domain/contracts.ts'
import { DiagnosisReportDraftSchema } from '../reports/schema.ts'

export const COMMERCE_TOOL_NAMES = [
  'query_sales',
  'query_inventory',
  'query_promotions',
  'compute_margin',
  'query_ads',
  'get_evidence',
  'validate_report',
  'create_proposal',
  'get_proposal',
] as const

export type CommerceToolName = (typeof COMMERCE_TOOL_NAMES)[number]

const WindowInputSchema = z.object({
  start: IsoDateTimeSchema,
  end: IsoDateTimeSchema,
  timezone: z.string().min(1),
}).strict()

export const QueryToolInputSchema = z.object({
  run_id: IdentifierSchema,
  case_id: IdentifierSchema,
  trace_id: IdentifierSchema.optional(),
  shop_id: IdentifierSchema,
  sku_ids: z.array(IdentifierSchema).min(1).max(100),
  window: WindowInputSchema,
  as_of: IsoDateTimeSchema.optional(),
  currency: CurrencySchema.default('CNY'),
}).strict()

export const GetEvidenceInputSchema = QueryToolInputSchema.extend({
  evidence_id: z.string().regex(/^ev_[a-f0-9]{24}$/),
}).strict()

export const ValidateReportInputSchema = z.object({
  trace_id: IdentifierSchema,
  report: DiagnosisReportDraftSchema,
}).strict().superRefine((input, context) => {
  if (input.trace_id !== input.report.traceId) {
    context.addIssue({ code: 'custom', path: ['trace_id'], message: 'trace_id must match report.traceId' })
  }
})

export const CreateProposalInputSchema = z.object({
  trace_id: IdentifierSchema,
  report_id: z.string().regex(/^report_[a-f0-9]{24}$/),
  recommendation_id: IdentifierSchema,
  expires_at: IsoDateTimeSchema,
}).strict()

export const GetProposalInputSchema = z.object({
  trace_id: IdentifierSchema,
  proposal_id: z.string().regex(/^proposal_[a-f0-9]{24}$/),
}).strict()

export type QueryToolInput = z.input<typeof QueryToolInputSchema>
export type ParsedQueryToolInput = z.output<typeof QueryToolInputSchema>
export type GetEvidenceInput = z.input<typeof GetEvidenceInputSchema>

export function toQueryContext(input: ParsedQueryToolInput, traceId: string, now: () => Date): QueryContext {
  return {
    runId: input.run_id,
    caseId: input.case_id,
    traceId,
    shopId: input.shop_id,
    skuIds: [...input.sku_ids],
    window: TimeRangeSchema.parse(input.window),
    asOf: input.as_of ?? now().toISOString(),
    currency: input.currency,
  }
}

const WINDOW_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['start', 'end', 'timezone'],
  properties: {
    start: { type: 'string', format: 'date-time', description: 'Inclusive ISO 8601 timestamp with offset.' },
    end: { type: 'string', format: 'date-time', description: 'Exclusive ISO 8601 timestamp with offset.' },
    timezone: { type: 'string', description: 'IANA timezone, for example Asia/Shanghai.' },
  },
} as const

export const QUERY_TOOL_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['run_id', 'case_id', 'shop_id', 'sku_ids', 'window'],
  properties: {
    run_id: { type: 'string', description: 'Correlation ID for this diagnosis run.' },
    case_id: { type: 'string', description: 'Correlation ID for the business case.' },
    trace_id: { type: 'string', description: 'Optional caller trace ID; generated when omitted.' },
    shop_id: { type: 'string', description: 'Shop identifier within the server-configured scope.' },
    sku_ids: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string' } },
    window: WINDOW_JSON_SCHEMA,
    as_of: { type: 'string', format: 'date-time', description: 'Observation cutoff; defaults to server time.' },
    currency: { type: 'string', pattern: '^[A-Z]{3}$', default: 'CNY' },
  },
} as const

export const GET_EVIDENCE_JSON_SCHEMA = {
  ...QUERY_TOOL_JSON_SCHEMA,
  required: [...QUERY_TOOL_JSON_SCHEMA.required, 'evidence_id'],
  properties: {
    ...QUERY_TOOL_JSON_SCHEMA.properties,
    evidence_id: { type: 'string', pattern: '^ev_[a-f0-9]{24}$' },
  },
} as const

export const VALIDATE_REPORT_JSON_SCHEMA = z.toJSONSchema(ValidateReportInputSchema, {
  target: 'draft-7',
  unrepresentable: 'any',
})

export const CREATE_PROPOSAL_JSON_SCHEMA = z.toJSONSchema(CreateProposalInputSchema, {
  target: 'draft-7', unrepresentable: 'any',
})

export const GET_PROPOSAL_JSON_SCHEMA = z.toJSONSchema(GetProposalInputSchema, {
  target: 'draft-7', unrepresentable: 'any',
})
