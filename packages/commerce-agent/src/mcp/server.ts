#!/usr/bin/env bun
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js'
import { FixtureAdapter } from '../adapters/fixture-adapter.ts'
import type { ToolEnvelope } from '../domain/contracts.ts'
import { CommerceError } from '../domain/errors.ts'
import { EvidenceRepository } from '../evidence/evidence-repository.ts'
import { ReportRepository } from '../reports/report-repository.ts'
import { CommerceDatabase } from '../storage/database.ts'
import { ProposalRepository } from '../approvals/repository.ts'
import { ProposalService } from '../approvals/proposal-service.ts'
import { computeMarginTool } from '../tools/compute-margin.ts'
import { getEvidenceTool } from '../tools/get-evidence.ts'
import { queryAdsTool } from '../tools/query-ads.ts'
import type { CommerceToolDependencies } from '../tools/context.ts'
import { queryInventoryTool } from '../tools/query-inventory.ts'
import { queryPromotionsTool } from '../tools/query-promotions.ts'
import { querySalesTool } from '../tools/query-sales.ts'
import { validateReportTool } from '../tools/validate-report.ts'
import { createProposalTool } from '../tools/create-proposal.ts'
import { getProposalTool } from '../tools/get-proposal.ts'
import {
  COMMERCE_TOOL_NAMES,
  CREATE_PROPOSAL_JSON_SCHEMA,
  GET_EVIDENCE_JSON_SCHEMA,
  GET_PROPOSAL_JSON_SCHEMA,
  QUERY_TOOL_JSON_SCHEMA,
  VALIDATE_REPORT_JSON_SCHEMA,
  type CommerceToolName,
} from './schemas.ts'
import { ToolRunner, type ToolExecutionContext } from './tool-runner.ts'
import { JsonlTraceRecorder, MemoryTraceRecorder, redactErrorMessage, type TraceRecorder } from './trace.ts'

const TOOL_DESCRIPTIONS: Record<CommerceToolName, string> = {
  query_sales: 'Query paid orders and refund events for a shop/SKU/time window, then return deterministic sales metrics with evidence.',
  query_inventory: 'Query inventory snapshots and calculate stockout, coverage, and estimated lost-sales metrics with evidence.',
  query_promotions: 'Query promotions intersecting the requested shop/SKU/time window with stacking and sponsor details.',
  compute_margin: 'Calculate deterministic contribution margin from sales and product cost rules for a scoped time window.',
  query_ads: 'Query advertising records and calculate spend, CTR, CVR, and ROAS with attribution-window evidence.',
  get_evidence: 'Retrieve the immutable evidence payload for an evidence ID within the same shop and SKU scope.',
  validate_report: 'Validate evidence, scope, units, language, and structure, then persist and read back a diagnosis report artifact.',
  create_proposal: 'Create an immutable, pending human-approval proposal from a validated RESOLVED report recommendation.',
  get_proposal: 'Read proposal status, immutable parameters, approval expiry, and idempotency metadata.',
}

export const COMMERCE_TOOLS: Tool[] = COMMERCE_TOOL_NAMES.map(name => ({
  name,
  description: TOOL_DESCRIPTIONS[name],
  inputSchema: (
    name === 'get_evidence'
      ? GET_EVIDENCE_JSON_SCHEMA
      : name === 'validate_report'
        ? VALIDATE_REPORT_JSON_SCHEMA
        : name === 'create_proposal'
          ? CREATE_PROPOSAL_JSON_SCHEMA
          : name === 'get_proposal'
            ? GET_PROPOSAL_JSON_SCHEMA
        : QUERY_TOOL_JSON_SCHEMA
  ) as unknown as Tool['inputSchema'],
}))

export type CommerceServerOptions = {
  fixtureDir: string
  allowedShopId: string
  reportDir: string
  dbPath?: string
  traceRecorder?: TraceRecorder
  runner?: ToolRunner
  now?: () => Date
}

export type CommerceServerRuntime = {
  server: Server
  evidence: EvidenceRepository
  reports: ReportRepository
  store: CommerceDatabase
  runner: ToolRunner
}

function errorResult(error: unknown): CallToolResult {
  const commerceError = error instanceof CommerceError
    ? error
    : new CommerceError('INTERNAL', error instanceof Error ? error.message : String(error))
  const traceId = typeof commerceError.details?.traceId === 'string' ? commerceError.details.traceId : undefined
  return {
    isError: true,
    content: [{
      type: 'text',
      text: JSON.stringify({
        status: 'error',
        error: {
          code: commerceError.code,
          message: redactErrorMessage(commerceError.message),
          retryable: commerceError.code === 'RATE_LIMITED' || commerceError.code === 'UPSTREAM_TIMEOUT',
        },
        attempts: typeof commerceError.details?.attempts === 'number' ? commerceError.details.attempts : 1,
        trace_id: traceId,
      }),
    }],
  }
}

export function createCommerceServer(options: CommerceServerOptions): CommerceServerRuntime {
  const store = new CommerceDatabase(options.dbPath ?? ':memory:')
  const evidence = new EvidenceRepository(store)
  const reports = new ReportRepository(options.reportDir, store)
  const proposalRepository = new ProposalRepository(store)
  const proposals = new ProposalService({ reports, repository: proposalRepository, now: options.now })
  const adapter = new FixtureAdapter({
    fixtureDir: options.fixtureDir,
    allowedShopId: options.allowedShopId,
    evidence,
  })
  const runner = options.runner ?? new ToolRunner({ traceRecorder: options.traceRecorder })
  const dependencies: CommerceToolDependencies = {
    adapter,
    evidence,
    reports,
    proposals,
    now: options.now ?? (() => new Date()),
  }
  const handlers: Record<CommerceToolName, (
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ) => Promise<ToolEnvelope<unknown>>> = {
    query_sales: (args, context) => querySalesTool(args, context, dependencies),
    query_inventory: (args, context) => queryInventoryTool(args, context, dependencies),
    query_promotions: (args, context) => queryPromotionsTool(args, context, dependencies),
    compute_margin: (args, context) => computeMarginTool(args, context, dependencies),
    query_ads: (args, context) => queryAdsTool(args, context, dependencies),
    get_evidence: (args, context) => getEvidenceTool(args, context, dependencies),
    validate_report: (args, context) => validateReportTool(args, context, dependencies),
    create_proposal: (args, context) => createProposalTool(args, context, dependencies),
    get_proposal: (args, context) => getProposalTool(args, context, dependencies),
  }
  const server = new Server(
    { name: 'craft-commerce-agent', version: '0.4.0' },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: COMMERCE_TOOLS }))
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const name = request.params.name as CommerceToolName
    const handler = handlers[name]
    if (!handler) return errorResult(new CommerceError('NOT_FOUND', `Unknown tool: ${request.params.name}`))

    try {
      const result = await runner.execute(
        name,
        (request.params.arguments ?? {}) as Record<string, unknown>,
        handler,
      )
      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    } catch (error) {
      return errorResult(error)
    }
  })

  return { server, evidence, reports, store, runner }
}

function createTraceRecorderFromEnvironment(): TraceRecorder {
  const traceFile = process.env.COMMERCE_TRACE_FILE
  return traceFile ? new JsonlTraceRecorder(traceFile) : new MemoryTraceRecorder()
}

export async function startStdioServer(): Promise<void> {
  const mode = process.env.COMMERCE_MODE ?? 'readonly'
  if (mode !== 'governed-mock' && mode !== 'readonly') throw new Error(`Unsupported COMMERCE_MODE: ${mode}`)

  const fixtureDir = process.env.COMMERCE_FIXTURE_DIR ?? resolve(import.meta.dir, '../../fixtures')
  if (!existsSync(fixtureDir)) throw new Error(`Commerce fixture directory does not exist: ${fixtureDir}`)
  const allowedShopId = process.env.COMMERCE_SHOP_ID ?? 'demo-shop'
  const reportDir = process.env.COMMERCE_REPORT_DIR ?? resolve(import.meta.dir, '../../demo/artifacts')
  const dbPath = process.env.COMMERCE_DB_PATH ?? resolve(reportDir, 'commerce.sqlite')
  const runtime = createCommerceServer({
    fixtureDir,
    allowedShopId,
    reportDir,
    dbPath,
    traceRecorder: createTraceRecorderFromEnvironment(),
  })
  await runtime.server.connect(new StdioServerTransport())
  console.error(`Commerce MCP Server started in ${mode} mode for shop ${allowedShopId}`)
}

if (import.meta.main) {
  startStdioServer().catch(error => {
    console.error(`Commerce MCP Server failed: ${redactErrorMessage(error instanceof Error ? error.message : String(error))}`)
    process.exit(1)
  })
}
