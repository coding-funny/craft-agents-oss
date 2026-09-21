import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { CraftMcpClient } from '@craft-agent/shared/mcp'
import { loadSource, SourceServerBuilder } from '@craft-agent/shared/sources'
import { runCommerceSetup } from '../src/setup/setup-check.ts'
import { DIAGNOSIS_SKILL_SLUG, DIAGNOSIS_SOURCE_SLUG, runDiagnosisCase } from '../src/diagnosis/workflow.ts'

const temporaryDirectories: string[] = []

function tempWorkspace(): string {
  const path = mkdtempSync(resolve(tmpdir(), 'commerce-mcp-'))
  temporaryDirectories.push(path)
  return path
}

function queryInput() {
  return {
    run_id: 'run-host-001',
    case_id: 'case-host-001',
    trace_id: 'trace-host-001',
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
}

function textPayload(result: unknown): Record<string, any> {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content
  const text = content?.find(item => item.type === 'text')?.text
  if (!text) throw new Error('MCP result did not contain text JSON')
  return JSON.parse(text) as Record<string, any>
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('Commerce MCP host integration', () => {
  it('loads through SourceServerBuilder and calls tools through the host MCP client', async () => {
    const workspace = tempWorkspace()
    const repoRoot = resolve(import.meta.dir, '../../..')
    runCommerceSetup({ workspaceRoot: workspace, repoRoot, bunPath: process.execPath }, 'apply')
    const source = loadSource(workspace, 'commerce')
    expect(source).not.toBeNull()
    const built = new SourceServerBuilder().buildMcpServer(source!, null)
    expect(built?.type).toBe('stdio')
    if (!built || built.type !== 'stdio') throw new Error('Expected stdio Source')

    const client = new CraftMcpClient({
      transport: 'stdio',
      command: built.command,
      args: built.args,
      env: built.env,
    })
    try {
      const tools = await client.listTools()
      expect(tools.map(tool => tool.name)).toEqual([
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
      const sales = textPayload(await client.callTool('query_sales', queryInput()))
      expect(sales.status).toBe('ok')
      expect(sales.data.metrics.netSalesMinor.value).toBe(110000)
      expect(sales.traceId).toBe('trace-host-001')
      const evidenceId = sales.evidence[0].evidenceId as string

      const inventory = textPayload(await client.callTool('query_inventory', queryInput()))
      expect(inventory.data.metrics.stockoutSkuCount.value).toBe(1)

      const promotions = textPayload(await client.callTool('query_promotions', {
        ...queryInput(),
        sku_ids: ['SKU-B'],
      }))
      expect(promotions.data[0].promotionId).toBe('PROMO-B-DISCOUNT')

      const margin = textPayload(await client.callTool('compute_margin', {
        ...queryInput(),
        sku_ids: ['SKU-B'],
      }))
      expect(margin.data.contributionRate.value).toBe(0.1)

      const ads = textPayload(await client.callTool('query_ads', {
        ...queryInput(),
        sku_ids: ['SKU-C'],
      }))
      expect(ads.data.metrics.roas.value).toBe(1.6)

      const evidence = textPayload(await client.callTool('get_evidence', {
        ...queryInput(),
        evidence_id: evidenceId,
      }))
      expect(evidence.data.evidenceId).toBe(evidenceId)
      expect(evidence.evidence[0].traceId).toBe('trace-host-001')

      const baselineInput = {
        ...queryInput(),
        window: {
          start: '2026-09-01T00:00:00+08:00',
          end: '2026-09-08T00:00:00+08:00',
          timezone: 'Asia/Shanghai',
        },
      }
      const baselineSales = textPayload(await client.callTool('query_sales', baselineInput))
      const baselineEvidenceId = baselineSales.evidence[0].evidenceId as string
      const baselineEvidence = textPayload(await client.callTool('get_evidence', {
        ...baselineInput,
        evidence_id: baselineEvidenceId,
      })).data
      const currentEvidence = evidence.data
      const reportResult = textPayload(await client.callTool('validate_report', {
        trace_id: 'trace-host-001',
        report: {
          traceId: 'trace-host-001',
          caseId: 'case-host-001',
          generatedAt: '2026-09-15T09:00:00+08:00',
          status: 'RESOLVED',
          scope: {
            shopId: 'demo-shop',
            skuIds: ['SKU-A'],
            baselineWindow: baselineInput.window,
            currentWindow: queryInput().window,
            currency: 'CNY',
          },
          executiveSummary: { statement: 'Net sales changed across the comparison windows.', evidenceIds: [baselineEvidenceId, evidenceId] },
          kpis: [{
            name: 'net_sales',
            baseline: { value: baselineSales.data.metrics.netSalesMinor.value, unit: 'CNY_minor', evidenceIds: [baselineEvidenceId] },
            current: { value: sales.data.metrics.netSalesMinor.value, unit: 'CNY_minor', evidenceIds: [evidenceId] },
            changeRate: -0.45,
          }],
          anomalies: [{ kind: 'FACT', statement: 'Current net sales are below baseline.', evidenceIds: [baselineEvidenceId, evidenceId] }],
          hypotheses: [{
            kind: 'HYPOTHESIS',
            statement: 'The change requires inventory and traffic investigation.',
            confidence: 'LOW',
            confidenceScore: 0.4,
            supportingEvidenceIds: [baselineEvidenceId, evidenceId],
            counterEvidenceIds: [],
            limitations: ['Only sales evidence is included.'],
          }],
          evidence: [baselineEvidence, currentEvidence].map(item => ({
            evidenceId: item.evidenceId,
            source: item.source,
            asOf: item.asOf,
            summary: item.summary,
          })),
          risks: ['This is fixture data.'],
          unknowns: [],
          recommendations: [{
            recommendationId: 'rec-host-collect-data',
            kind: 'RECOMMENDATION',
            action: 'Collect inventory and traffic evidence before proposing a change.',
            rationale: 'Sales evidence alone does not identify a root cause.',
            riskLevel: 'LOW',
            evidenceIds: [baselineEvidenceId, evidenceId],
            actionDraft: {
              actionType: 'CREATE_REPLENISHMENT_TASK',
              targetId: 'SKU-A',
              parameters: { requestedQty: 10 },
              preconditions: ['Inventory evidence is collected.'],
              expectedImpact: 'Create a reviewable mock task.',
              rollbackPlan: 'Cancel the mock task.',
            },
          }],
        },
      }))
      expect(reportResult.status).toBe('ok')
      expect(reportResult.data.reportId).toMatch(/^report_[a-f0-9]{24}$/)
      expect(existsSync(reportResult.data.jsonPath)).toBe(true)

      const mismatchedTrace = await client.callTool('create_proposal', {
        trace_id: 'trace-wrong-001',
        report_id: reportResult.data.reportId,
        recommendation_id: 'rec-host-collect-data',
        expires_at: '2099-09-18T09:00:00+08:00',
      })
      expect((mismatchedTrace as { isError?: boolean }).isError).toBe(true)
      expect(textPayload(mismatchedTrace).error.message).toContain('source report traceId')

      const proposal = textPayload(await client.callTool('create_proposal', {
        trace_id: 'trace-host-001',
        report_id: reportResult.data.reportId,
        recommendation_id: 'rec-host-collect-data',
        expires_at: '2099-09-18T09:00:00+08:00',
      }))
      expect(proposal.data.status).toBe('PENDING_APPROVAL')
      const proposalRead = textPayload(await client.callTool('get_proposal', {
        trace_id: 'trace-host-001',
        proposal_id: proposal.data.proposalId,
      }))
      expect(proposalRead.data.proposalId).toBe(proposal.data.proposalId)

      const invalidResult = await client.callTool('query_sales', { ...queryInput(), sku_ids: [] })
      const invalid = textPayload(invalidResult)
      expect((invalidResult as { isError?: boolean }).isError).toBe(true)
      expect(invalid.error.code).toBe('INVALID_ARGUMENT')
    } finally {
      await client.close()
    }

    const tracePath = resolve(workspace, '.commerce/traces.jsonl')
    expect(existsSync(tracePath)).toBe(true)
    const traces = readFileSync(tracePath, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(traces.some(trace => trace.tool === 'query_sales' && trace.status === 'succeeded')).toBe(true)
  }, 20_000)

  it('surfaces a disconnected stdio server as a rejected host client operation', async () => {
    const client = new CraftMcpClient({
      transport: 'stdio',
      command: '/definitely/missing/commerce-bun',
      args: ['run', '/missing/server.ts'],
    })
    try {
      await expect(client.listTools()).rejects.toBeInstanceOf(Error)
    } finally {
      await client.close().catch(() => {})
    }
  })

  it('reconnects a host client and reads the same persisted proposal', async () => {
    const workspace = tempWorkspace()
    const repoRoot = resolve(import.meta.dir, '../../..')
    runCommerceSetup({ workspaceRoot: workspace, repoRoot, bunPath: process.execPath }, 'apply')
    const persisted = await runDiagnosisCase('ads-conversion', {
      fixtureDir: resolve(repoRoot, 'packages/commerce-agent/fixtures'),
      reportDir: resolve(workspace, '.commerce/reports'),
      dbPath: resolve(workspace, '.commerce/commerce.sqlite'),
      skillSlugs: [DIAGNOSIS_SKILL_SLUG],
      sourceSlugs: [DIAGNOSIS_SOURCE_SLUG],
    })
    const source = loadSource(workspace, 'commerce')!
    const built = new SourceServerBuilder().buildMcpServer(source, null)
    if (!built || built.type !== 'stdio') throw new Error('Expected stdio Source')
    const connection = { transport: 'stdio' as const, command: built.command, args: built.args, env: built.env }
    const first = new CraftMcpClient(connection)
    let proposalId = ''
    try {
      const created = textPayload(await first.callTool('create_proposal', {
        trace_id: persisted.report.traceId,
        report_id: persisted.report.reportId,
        recommendation_id: 'rec-ad-budget-review',
        expires_at: '2099-09-18T09:00:00+08:00',
      }))
      proposalId = created.data.proposalId
    } finally {
      await first.close()
    }

    const second = new CraftMcpClient(connection)
    try {
      const reopened = textPayload(await second.callTool('get_proposal', {
        trace_id: 'trace-reconnect-002',
        proposal_id: proposalId,
      }))
      expect(reopened.data.proposalId).toBe(proposalId)
      expect(reopened.data.status).toBe('PENDING_APPROVAL')
    } finally {
      await second.close()
    }
  }, 20_000)
})
