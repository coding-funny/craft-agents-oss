#!/usr/bin/env bun
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { CraftMcpClient } from '@craft-agent/shared/mcp'
import { loadSource, SourceServerBuilder } from '@craft-agent/shared/sources'
import { ProposalRepository } from '../src/approvals/repository.ts'
import { CaseRepository } from '../src/recovery/case-repository.ts'
import { runRecoverableCase } from '../src/recovery/runner.ts'
import { runCommerceSetup } from '../src/setup/setup-check.ts'
import { CommerceDatabase } from '../src/storage/database.ts'

export type DemoResult = {
  sourceSetup: { created: number; unchanged: number }
  mcpSmoke?: { toolCount: number; netSalesMinor: number; traceId: string }
  firstRun: Awaited<ReturnType<typeof runRecoverableCase>>
  replayRun: Awaited<ReturnType<typeof runRecoverableCase>>
  operationCount: number
  auditEventCount: number
  caseEventCount: number
  evidence: {
    databasePath: string
    reportDirectory: string
    summaryPath: string
  }
}

function textPayload(result: unknown): Record<string, any> {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content
  const text = content?.find(item => item.type === 'text')?.text
  if (!text) throw new Error('MCP result did not contain JSON text')
  return JSON.parse(text) as Record<string, any>
}

async function mcpSmoke(workspaceRoot: string): Promise<DemoResult['mcpSmoke']> {
  const source = loadSource(workspaceRoot, 'commerce')
  if (!source) throw new Error('Commerce Source was not installed')
  const built = new SourceServerBuilder().buildMcpServer(source, null)
  if (!built || built.type !== 'stdio') throw new Error('Commerce Source did not build as stdio MCP')
  const client = new CraftMcpClient({ transport: 'stdio', command: built.command, args: built.args, env: built.env })
  try {
    const tools = await client.listTools()
    const sales = textPayload(await client.callTool('query_sales', {
      run_id: 'run-demo-mcp', case_id: 'case-demo-mcp', trace_id: 'trace-demo-mcp',
      shop_id: 'demo-shop', sku_ids: ['SKU-A'],
      window: { start: '2026-09-08T00:00:00+08:00', end: '2026-09-15T00:00:00+08:00', timezone: 'Asia/Shanghai' },
      as_of: '2026-09-15T09:00:00+08:00', currency: 'CNY',
    }))
    return { toolCount: tools.length, netSalesMinor: sales.data.metrics.netSalesMinor.value, traceId: sales.traceId }
  } finally {
    await client.close()
  }
}

export async function runDemo(options: { runtimeRoot?: string; artifactRoot?: string; mcpSmoke?: boolean } = {}): Promise<DemoResult> {
  const packageRoot = resolve(import.meta.dir, '..')
  const repoRoot = resolve(packageRoot, '../..')
  const runtimeRoot = options.runtimeRoot ?? resolve(packageRoot, 'demo/runtime')
  const artifactRoot = options.artifactRoot ?? (options.runtimeRoot ? resolve(runtimeRoot, 'artifacts') : resolve(packageRoot, 'demo'))
  const workspaceRoot = resolve(runtimeRoot, 'workspace')
  const caseRoot = resolve(runtimeRoot, 'case')
  const fixtureDir = resolve(packageRoot, 'fixtures')
  const actions = runCommerceSetup({ workspaceRoot, repoRoot, bunPath: process.execPath }, 'apply').actions
  const smoke = options.mcpSmoke === false ? undefined : await mcpSmoke(workspaceRoot)

  const base = {
    rootDir: caseRoot,
    fixtureDir,
    sessionId: 'session-commerce-demo-ads',
    caseName: 'ads-conversion' as const,
    autoApprove: true,
    actor: 'demo-operator',
  }
  const firstRun = await runRecoverableCase(base)
  const replayRun = await runRecoverableCase(base)

  const databasePath = resolve(caseRoot, 'commerce.sqlite')
  const store = new CommerceDatabase(databasePath)
  const operationCount = store.database.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM mock_operations').get()!.count
  const repository = new ProposalRepository(store)
  const auditEventCount = firstRun.proposalId ? repository.listAudit(firstRun.proposalId).length : 0
  const caseEventCount = new CaseRepository(store).listEvents(base.sessionId).length
  store.close()

  const summaryPath = resolve(artifactRoot, 'results/latest-demo.json')
  const result: DemoResult = {
    sourceSetup: {
      created: actions.filter(action => action.action === 'create').length,
      unchanged: actions.filter(action => action.action === 'unchanged').length,
    },
    mcpSmoke: smoke,
    firstRun,
    replayRun,
    operationCount,
    auditEventCount,
    caseEventCount,
    evidence: { databasePath, reportDirectory: resolve(caseRoot, 'reports'), summaryPath },
  }
  await mkdir(resolve(artifactRoot, 'results'), { recursive: true })
  await mkdir(resolve(artifactRoot, 'traces'), { recursive: true })
  await writeFile(summaryPath, `${JSON.stringify(result, null, 2)}\n`)
  await writeFile(resolve(artifactRoot, 'traces/demo-summary.json'), `${JSON.stringify({
    sessionId: firstRun.sessionId,
    traceId: replayRun.traceId,
    parentTraceId: replayRun.parentTraceId,
    reportId: firstRun.reportId,
    proposalId: firstRun.proposalId,
    status: replayRun.status,
    operationCount,
    auditEventCount,
    caseEventCount,
  }, null, 2)}\n`)
  return result
}

if (import.meta.main) {
  runDemo().then(result => {
    console.log(JSON.stringify({
      session_id: result.firstRun.sessionId,
      report_id: result.firstRun.reportId,
      proposal_id: result.firstRun.proposalId,
      trace_id: result.replayRun.traceId,
      status: result.replayRun.status,
      mcp_tools: result.mcpSmoke?.toolCount,
      operation_count: result.operationCount,
      replayed: result.replayRun.replayed,
      summary_path: result.evidence.summaryPath,
    }, null, 2))
    if (result.replayRun.status !== 'SUCCEEDED' || result.operationCount !== 1) process.exitCode = 1
  }).catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
