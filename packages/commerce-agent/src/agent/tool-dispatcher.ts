import { z } from 'zod'
import type { ResolvedScope } from '../contracts/task.ts'
import type { BudgetLedger } from './budget.ts'
import type { CompletedToolCall, ModelToolDefinition } from './model-port.ts'
import {
  ALLOWED_MODEL_TOOLS,
  ClarificationArgumentsSchema,
  CONTROL_MODEL_TOOLS,
  DOMAIN_MODEL_TOOLS,
  ModelEvidenceArgumentsSchema,
  ModelQueryArgumentsSchema,
  ModelValidateReportArgumentsSchema,
  RecordInvestigationArgumentsSchema,
  modelToolDefinitions,
  type AllowedModelToolName,
} from './tool-definitions.ts'
import { CommerceError } from '../domain/errors.ts'

export interface McpToolClient {
  listTools(): Promise<Array<{ name: string }>>
  callTool(name: string, args: Record<string, unknown>, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<unknown>
  close(): Promise<void>
}

export type InvestigationState = z.infer<typeof RecordInvestigationArgumentsSchema> & {
  evidenceIds: string[]
  toolHistory: Array<{ name: string; fingerprint: string; status: string }>
}

export type ToolDispatchResult = {
  callId: string
  name: string
  content: string
  isError: boolean
  reportId?: string
  clarification?: { fields: string[]; question: string }
  evidenceIds: string[]
}

export type TrustedRunContext = {
  runId: string
  taskId: string
  traceId: string
  asOf: string
  scope: ResolvedScope
  signal: AbortSignal
  toolTimeoutMs: number
}

function parseMcpResult(result: unknown): { value: unknown; isError: boolean } {
  const parsed = z.object({
    isError: z.boolean().optional(),
    content: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()).min(1),
  }).passthrough().parse(result)
  const text = parsed.content.find(item => item.type === 'text')?.text
  if (text === undefined) throw new CommerceError('MODEL_PROTOCOL_ERROR', 'MCP tool returned no text payload')
  try { return { value: JSON.parse(text), isError: parsed.isError === true } } catch {
    throw new CommerceError('MODEL_PROTOCOL_ERROR', 'MCP tool returned non-JSON text')
  }
}

function evidenceIds(value: unknown): string[] {
  const result = z.object({ evidence: z.array(z.object({ evidenceId: z.string() })).optional() }).passthrough().safeParse(value)
  return result.success ? [...new Set((result.data.evidence ?? []).map(item => item.evidenceId))] : []
}

function attemptCount(value: unknown): number {
  const parsed = z.object({ attempts: z.number().int().min(1).max(100).optional() }).passthrough().safeParse(value)
  return parsed.success ? parsed.data.attempts ?? 1 : 1
}

export class ScopedToolDispatcher {
  readonly #client: McpToolClient
  readonly #budget: BudgetLedger
  readonly #state: InvestigationState
  #available = new Set<string>()

  constructor(options: { client: McpToolClient; budget: BudgetLedger; state?: Partial<InvestigationState> }) {
    this.#client = options.client
    this.#budget = options.budget
    this.#state = {
      pendingSteps: [], facts: [], hypotheses: [], counterEvidence: [], missingData: [], evidenceIds: [], toolHistory: [],
      ...options.state,
    }
  }

  async initialize(): Promise<void> {
    this.#available = new Set((await this.#client.listTools()).map(tool => tool.name))
    for (const name of DOMAIN_MODEL_TOOLS) {
      if (!this.#available.has(name)) throw new CommerceError('TOOL_NOT_ALLOWED', `Required commerce tool is unavailable: ${name}`)
    }
  }

  definitions(): ModelToolDefinition[] { return modelToolDefinitions() }
  state(): InvestigationState { return structuredClone(this.#state) }

  preflight(calls: CompletedToolCall[], context: TrustedRunContext): void {
    if (calls.length === 0) return
    const names = calls.map(call => call.name)
    if (names.some(name => !ALLOWED_MODEL_TOOLS.includes(name as AllowedModelToolName))) {
      throw new CommerceError('TOOL_NOT_ALLOWED', 'Model requested a tool outside the commerce allowlist')
    }
    const control = names.some(name => CONTROL_MODEL_TOOLS.includes(name as never) || name === 'validate_report')
    if (control && calls.length !== 1) throw new CommerceError('MODEL_PROTOCOL_ERROR', 'Control and report tools must be the only call in a turn')
    for (const call of calls) this.#validateCall(call, context)
    this.#budget.reserveTools(calls.length)
  }

  async dispatch(call: CompletedToolCall, context: TrustedRunContext): Promise<ToolDispatchResult> {
    this.#validateCall(call, context)
    if (call.name === 'record_investigation') {
      const update = RecordInvestigationArgumentsSchema.parse(call.arguments)
      const visible = new Set(this.#state.evidenceIds)
      for (const fact of [...update.facts, ...update.counterEvidence]) {
        if (fact.evidenceIds.some(id => !visible.has(id))) throw new CommerceError('SCOPE_DENIED', 'Investigation state references evidence outside this task')
      }
      Object.assign(this.#state, update)
      return this.#localResult(call, { status: 'recorded' })
    }
    if (call.name === 'request_clarification') {
      const clarification = ClarificationArgumentsSchema.parse(call.arguments)
      return { ...this.#localResult(call, { status: 'waiting_input' }), clarification }
    }

    const args = this.#mcpArguments(call, context)
    let rawResult: unknown
    try {
      rawResult = await this.#client.callTool(call.name, args, {
        signal: context.signal, timeoutMs: context.toolTimeoutMs,
      })
    } catch (error) {
      this.#budget.recordToolAttempt()
      throw error
    }
    const result = parseMcpResult(rawResult)
    this.#budget.recordToolAttempts(attemptCount(result.value))
    const ids = evidenceIds(result.value)
    this.#state.evidenceIds = [...new Set([...this.#state.evidenceIds, ...ids])]
    this.#state.toolHistory.push({ name: call.name, fingerprint: this.fingerprint(call, context), status: result.isError ? 'error' : 'ok' })
    const reportId = z.object({ data: z.object({ reportId: z.string() }) }).passthrough().safeParse(result.value)
    return {
      callId: call.callId, name: call.name, content: JSON.stringify(result.value), isError: result.isError,
      reportId: reportId.success ? reportId.data.data.reportId : undefined, evidenceIds: ids,
    }
  }

  fingerprint(call: CompletedToolCall, context: TrustedRunContext): string {
    return JSON.stringify({ tool: call.name, args: call.arguments, scope: context.scope, taskId: context.taskId })
  }

  async close(): Promise<void> { await this.#client.close() }

  #localResult(call: CompletedToolCall, value: unknown): ToolDispatchResult {
    return { callId: call.callId, name: call.name, content: JSON.stringify(value), isError: false, evidenceIds: [] }
  }

  #validateCall(call: CompletedToolCall, context: TrustedRunContext): void {
    if (!ALLOWED_MODEL_TOOLS.includes(call.name as AllowedModelToolName)) {
      throw new CommerceError('TOOL_NOT_ALLOWED', `Tool is not allowed: ${call.name}`)
    }
    try {
      if (call.name === 'get_evidence') ModelEvidenceArgumentsSchema.parse(call.arguments)
      else if (call.name === 'validate_report') {
        const { report } = ModelValidateReportArgumentsSchema.parse(call.arguments)
        const candidate = report as Record<string, unknown>
        const scope = candidate.scope as Record<string, unknown> | undefined
        if (scope?.shopId !== context.scope.shopId || JSON.stringify(scope?.skuIds) !== JSON.stringify(context.scope.skuIds)) {
          throw new CommerceError('SCOPE_DENIED', 'Report scope differs from the trusted task scope')
        }
      } else if (call.name === 'record_investigation') RecordInvestigationArgumentsSchema.parse(call.arguments)
      else if (call.name === 'request_clarification') ClarificationArgumentsSchema.parse(call.arguments)
      else {
        const query = ModelQueryArgumentsSchema.parse(call.arguments)
        if (query.sku_ids?.some(id => !context.scope.skuIds.includes(id))) throw new CommerceError('SCOPE_DENIED', 'Query contains an unapproved SKU')
      }
    } catch (error) {
      if (error instanceof CommerceError) throw error
      throw new CommerceError('TOOL_SCHEMA_INVALID', `Invalid arguments for ${call.name}`)
    }
  }

  #mcpArguments(call: CompletedToolCall, context: TrustedRunContext): Record<string, unknown> {
    if (call.name === 'get_evidence') {
      const value = ModelEvidenceArgumentsSchema.parse(call.arguments)
      if (!this.#state.evidenceIds.includes(value.evidence_id)) throw new CommerceError('SCOPE_DENIED', 'Evidence is outside this task')
      return {
        run_id: context.runId, case_id: context.taskId, trace_id: context.traceId,
        shop_id: context.scope.shopId, sku_ids: context.scope.skuIds, window: context.scope.currentWindow,
        as_of: context.asOf, currency: context.scope.currency, evidence_id: value.evidence_id,
      }
    }
    if (call.name === 'validate_report') {
      return { trace_id: context.traceId, report: ModelValidateReportArgumentsSchema.parse(call.arguments).report }
    }
    const query = ModelQueryArgumentsSchema.parse(call.arguments)
    return {
      run_id: context.runId, case_id: context.taskId, trace_id: context.traceId,
      shop_id: context.scope.shopId, sku_ids: query.sku_ids ?? context.scope.skuIds,
      window: query.period === 'baseline' ? context.scope.baselineWindow : context.scope.currentWindow,
      as_of: context.asOf, currency: context.scope.currency,
    }
  }
}
