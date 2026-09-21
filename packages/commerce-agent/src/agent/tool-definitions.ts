import { z } from 'zod'
import type { ModelToolDefinition } from './model-port.ts'

export const QUERY_MODEL_TOOLS = ['query_sales', 'query_inventory', 'query_promotions', 'compute_margin', 'query_ads'] as const
export const DOMAIN_MODEL_TOOLS = [...QUERY_MODEL_TOOLS, 'get_evidence', 'validate_report'] as const
export const CONTROL_MODEL_TOOLS = ['record_investigation', 'request_clarification'] as const
export const ALLOWED_MODEL_TOOLS = [...DOMAIN_MODEL_TOOLS, ...CONTROL_MODEL_TOOLS] as const
export type AllowedModelToolName = (typeof ALLOWED_MODEL_TOOLS)[number]

export const ModelQueryArgumentsSchema = z.object({
  period: z.enum(['baseline', 'current']),
  sku_ids: z.array(z.string().min(1)).min(1).max(20).optional(),
}).strict()

export const ModelEvidenceArgumentsSchema = z.object({
  evidence_id: z.string().regex(/^ev_[a-f0-9]{24}$/),
}).strict()

export const ModelValidateReportArgumentsSchema = z.object({ report: z.record(z.string(), z.unknown()) }).strict()

export const RecordInvestigationArgumentsSchema = z.object({
  pendingSteps: z.array(z.string().min(1)).max(20).default([]),
  facts: z.array(z.object({ statement: z.string().min(1), evidenceIds: z.array(z.string()).min(1) }).strict()).max(30).default([]),
  hypotheses: z.array(z.object({ statement: z.string().min(1), evidenceIds: z.array(z.string()).default([]) }).strict()).max(20).default([]),
  counterEvidence: z.array(z.object({ statement: z.string().min(1), evidenceIds: z.array(z.string()).min(1) }).strict()).max(20).default([]),
  missingData: z.array(z.string().min(1)).max(20).default([]),
}).strict()

export const ClarificationArgumentsSchema = z.object({
  fields: z.array(z.enum(['scope.shopId', 'scope.skuIds', 'scope.baselineWindow', 'scope.currentWindow'])).min(1),
  question: z.string().min(1).max(1_000),
}).strict()

function schema(value: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(value) as Record<string, unknown>
}

const descriptions: Record<AllowedModelToolName, string> = {
  query_sales: 'Read deterministic sales and refund metrics for one approved comparison period.',
  query_inventory: 'Read inventory snapshots and stockout metrics for one approved comparison period.',
  query_promotions: 'Read promotions intersecting one approved comparison period.',
  compute_margin: 'Compute contribution margin from evidence-backed sales and product cost rules.',
  query_ads: 'Read advertising spend, CTR, CVR and ROAS for one approved comparison period.',
  get_evidence: 'Read one evidence payload already produced by this task.',
  validate_report: 'Validate and persist a complete diagnosis report. This must be the only tool call in its turn.',
  record_investigation: 'Record explicit investigation state. This does not turn hypotheses into facts.',
  request_clarification: 'Pause and ask for missing task scope. This must be the only tool call in its turn.',
}

export function modelToolDefinitions(): ModelToolDefinition[] {
  return ALLOWED_MODEL_TOOLS.map(name => ({
    name,
    description: descriptions[name],
    inputSchema: name === 'get_evidence' ? schema(ModelEvidenceArgumentsSchema)
      : name === 'validate_report' ? schema(ModelValidateReportArgumentsSchema)
        : name === 'record_investigation' ? schema(RecordInvestigationArgumentsSchema)
          : name === 'request_clarification' ? schema(ClarificationArgumentsSchema)
            : schema(ModelQueryArgumentsSchema),
  }))
}
