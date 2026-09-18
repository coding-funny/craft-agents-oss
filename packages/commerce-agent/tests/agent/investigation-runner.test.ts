import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { BudgetLedger } from '../../src/agent/budget.ts'
import { runInvestigation } from '../../src/agent/investigation-runner.ts'
import type { ModelEvent, ModelMessage, ModelTurnPort, ModelTurnRequest } from '../../src/agent/model-port.ts'
import { FakeModelTurnPort, ZERO_USAGE } from '../../src/agent/model-port.ts'
import { ScopedToolDispatcher, type McpToolClient } from '../../src/agent/tool-dispatcher.ts'
import { createInvestigationTask, type InvestigationTask } from '../../src/contracts/task.ts'
import { createScopedCommerceClient } from '../../src/mcp/scoped-client.ts'
import { ReportRepository } from '../../src/reports/report-repository.ts'
import { CommerceDatabase } from '../../src/storage/database.ts'
import { InvestigationRepository } from '../../src/storage/investigation-repository.ts'
import { COMPLETE_INPUT, TEST_BUDGET, TEST_PRINCIPAL } from './helpers.ts'

const temporaryDirectories: string[] = []

function temporaryRoot(): string {
  const path = mkdtempSync(resolve(tmpdir(), 'commerce-agent-runtime-'))
  temporaryDirectories.push(path)
  return path
}

function toolPayloads(messages: ModelMessage[], name: string): any[] {
  return messages.filter((message): message is Extract<ModelMessage, { role: 'tool' }> => message.role === 'tool' && message.toolName === name)
    .map(message => JSON.parse(message.content))
}

class ReactiveReportModel implements ModelTurnPort {
  #turn = 0
  #reportAttempt = 0
  readonly #task: InvestigationTask
  readonly #invalidReportAttempts: number
  constructor(task: InvestigationTask, invalidReportAttempts = 0) {
    this.#task = task
    this.#invalidReportAttempts = invalidReportAttempts
  }
  describe() {
    return { driver: 'reactive-test-fake', modelId: 'fake-e2e', mode: 'fake' as const, supportsTools: true, supportsAbort: true, usageMode: 'actual' as const }
  }
  async *generate(request: ModelTurnRequest): AsyncIterable<ModelEvent> {
    this.#turn += 1
    const call = (name: string, args: unknown) => ({
      type: 'turn_complete' as const,
      turn: { requestId: `request-${this.#turn}`, text: '', toolCalls: [{ callId: `call-${this.#turn}`, name, arguments: args }], stopReason: 'tool_use' as const, usage: ZERO_USAGE },
    })
    if (this.#turn === 1) { yield call('query_sales', { period: 'baseline' }); return }
    if (this.#turn === 2) { yield call('query_sales', { period: 'current' }); return }
    const sales = toolPayloads(request.messages, 'query_sales')
    if (this.#turn === 3) { yield call('get_evidence', { evidence_id: sales[0].evidence[0].evidenceId }); return }
    if (this.#turn === 4) { yield call('get_evidence', { evidence_id: sales[1].evidence[0].evidenceId }); return }
    const records = toolPayloads(request.messages, 'get_evidence').map(value => value.data)
    const baseline = sales[0]
    const current = sales[1]
    const baselineId = baseline.evidence[0].evidenceId
    const currentId = current.evidence[0].evidenceId
    const baselineValue = baseline.data.metrics.netSalesMinor.value
    const currentValue = current.data.metrics.netSalesMinor.value
    this.#reportAttempt += 1
    const reportedCurrentValue = this.#reportAttempt <= this.#invalidReportAttempts ? currentValue + 1 : currentValue
    const changeRate = Math.round(((reportedCurrentValue - baselineValue) / baselineValue) * 10_000) / 10_000
    const traceId = baseline.traceId
    yield call('validate_report', { report: {
      traceId,
      caseId: this.#task.taskId,
      generatedAt: this.#task.asOf,
      status: 'UNRESOLVED',
      scope: this.#task.resolvedScope,
      executiveSummary: { statement: 'Net sales changed across the approved windows.', evidenceIds: [baselineId, currentId] },
      kpis: [{
        name: 'net_sales',
        baseline: { value: baselineValue, unit: 'CNY_minor', evidenceIds: [baselineId] },
        current: { value: reportedCurrentValue, unit: 'CNY_minor', evidenceIds: [currentId] },
        changeRate,
      }],
      anomalies: [{ kind: 'FACT', statement: 'Current net sales are below baseline.', evidenceIds: [baselineId, currentId] }],
      hypotheses: [{
        kind: 'HYPOTHESIS', statement: 'Additional evidence is required to identify a cause.',
        confidence: 'LOW', confidenceScore: 0.3, supportingEvidenceIds: [baselineId, currentId],
        counterEvidenceIds: [], limitations: ['Only sales evidence was queried.'],
      }],
      evidence: records.map(record => ({ evidenceId: record.evidenceId, source: record.source, asOf: record.asOf, summary: record.summary })),
      risks: ['Do not act on sales evidence alone.'], unknowns: [], recommendations: [],
    } })
  }
  async close() {}
}

class NeverCalledClient implements McpToolClient {
  calls = 0
  async listTools() { this.calls += 1; return [] }
  async callTool() { this.calls += 1; return {} }
  async close() {}
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('T03/T25/T30 dynamic investigation runner', () => {
  it('T03 persists WAITING_INPUT without model or domain queries', async () => {
    const root = temporaryRoot()
    const store = new CommerceDatabase(resolve(root, 'runtime.sqlite'))
    const client = new NeverCalledClient()
    const ledger = new BudgetLedger(TEST_BUDGET)
    try {
      const task = createInvestigationTask({ schemaVersion: 1, question: 'What changed?' }, {
        principal: TEST_PRINCIPAL, asOf: '2026-09-15T09:00:00+08:00', fixtureDigest: 'fixture-test', taskId: 'task-waiting',
      })
      const model = new FakeModelTurnPort([{ error: 'must not be called' }])
      const result = await runInvestigation({
        task, budgetConfig: TEST_BUDGET, repository: new InvestigationRepository(store),
        reports: new ReportRepository(resolve(root, 'reports'), store), model,
        dispatcher: new ScopedToolDispatcher({ client, budget: ledger }), ledger,
      })
      expect(result.status).toBe('WAITING_INPUT')
      expect(result.clarification?.fields).toContain('scope.skuIds')
      expect(model.requests).toHaveLength(0)
      expect(client.calls).toBe(0)
    } finally { store.close() }
  })

  it('T25 refuses textual completion without validate_report', async () => {
    const root = temporaryRoot()
    const store = new CommerceDatabase(resolve(root, 'runtime.sqlite'))
    const client: McpToolClient = {
      listTools: async () => ['query_sales', 'query_inventory', 'query_promotions', 'compute_margin', 'query_ads', 'get_evidence', 'validate_report'].map(name => ({ name })),
      callTool: async () => { throw new Error('no tool expected') }, close: async () => {},
    }
    const ledger = new BudgetLedger(TEST_BUDGET)
    try {
      const task = createInvestigationTask(COMPLETE_INPUT, {
        principal: TEST_PRINCIPAL, asOf: '2026-09-15T09:00:00+08:00', fixtureDigest: 'fixture-test', taskId: 'task-false-complete',
      })
      const model = new FakeModelTurnPort([1, 2].map(index => ({
        requestId: `request-${index}`, text: 'Investigation complete.', toolCalls: [], stopReason: 'stop' as const, usage: ZERO_USAGE,
      })))
      const result = await runInvestigation({
        task, budgetConfig: TEST_BUDGET, repository: new InvestigationRepository(store),
        reports: new ReportRepository(resolve(root, 'reports'), store), model,
        dispatcher: new ScopedToolDispatcher({ client, budget: ledger }), ledger,
      })
      expect(result.status).toBe('FAILED')
      expect(result.error?.code).toBe('REPORT_NOT_VALIDATED')
      expect(result.report).toBeUndefined()
    } finally { store.close() }
  })

  it('T08 does not dispatch tool calls from a truncated model turn', async () => {
    const root = temporaryRoot()
    const store = new CommerceDatabase(resolve(root, 'runtime.sqlite'))
    let domainCalls = 0
    const client: McpToolClient = {
      listTools: async () => ['query_sales', 'query_inventory', 'query_promotions', 'compute_margin', 'query_ads', 'get_evidence', 'validate_report'].map(name => ({ name })),
      callTool: async () => { domainCalls += 1; return {} }, close: async () => {},
    }
    const ledger = new BudgetLedger(TEST_BUDGET)
    try {
      const task = createInvestigationTask(COMPLETE_INPUT, {
        principal: TEST_PRINCIPAL, asOf: '2026-09-15T09:00:00+08:00', fixtureDigest: 'fixture-test', taskId: 'task-truncated',
      })
      const model = new FakeModelTurnPort([{
        requestId: 'request-truncated', text: '',
        toolCalls: [{ callId: 'partial', name: 'query_sales', arguments: { period: 'current' } }],
        stopReason: 'length', usage: ZERO_USAGE,
      }])
      const result = await runInvestigation({
        task, budgetConfig: TEST_BUDGET, repository: new InvestigationRepository(store),
        reports: new ReportRepository(resolve(root, 'reports'), store), model,
        dispatcher: new ScopedToolDispatcher({ client, budget: ledger }), ledger,
      })
      expect(result.status).toBe('FAILED')
      expect(result.error?.code).toBe('MODEL_PROTOCOL_ERROR')
      expect(domainCalls).toBe(0)
    } finally { store.close() }
  })

  it('T29 redacts provider secrets from persisted results', async () => {
    const root = temporaryRoot()
    const store = new CommerceDatabase(resolve(root, 'runtime.sqlite'))
    const client: McpToolClient = {
      listTools: async () => ['query_sales', 'query_inventory', 'query_promotions', 'compute_margin', 'query_ads', 'get_evidence', 'validate_report'].map(name => ({ name })),
      callTool: async () => ({}), close: async () => {},
    }
    const ledger = new BudgetLedger(TEST_BUDGET)
    try {
      const task = createInvestigationTask(COMPLETE_INPUT, {
        principal: TEST_PRINCIPAL, asOf: '2026-09-15T09:00:00+08:00', fixtureDigest: 'fixture-test', taskId: 'task-redaction',
      })
      const result = await runInvestigation({
        task, budgetConfig: TEST_BUDGET, repository: new InvestigationRepository(store),
        reports: new ReportRepository(resolve(root, 'reports'), store),
        model: new FakeModelTurnPort([{ error: 'provider rejected api_key=TOPSECRET' }]),
        dispatcher: new ScopedToolDispatcher({ client, budget: ledger }), ledger,
      })
      expect(JSON.stringify(result)).not.toContain('TOPSECRET')
      expect(result.error?.message).toContain('[REDACTED]')
    } finally { store.close() }
  })

  it('T32 settles an externally aborted run once and starts no domain call', async () => {
    const root = temporaryRoot()
    const store = new CommerceDatabase(resolve(root, 'runtime.sqlite'))
    let domainCalls = 0
    const client: McpToolClient = {
      listTools: async () => ['query_sales', 'query_inventory', 'query_promotions', 'compute_margin', 'query_ads', 'get_evidence', 'validate_report'].map(name => ({ name })),
      callTool: async () => { domainCalls += 1; return {} }, close: async () => {},
    }
    const controller = new AbortController()
    controller.abort()
    const ledger = new BudgetLedger(TEST_BUDGET)
    try {
      const task = createInvestigationTask(COMPLETE_INPUT, {
        principal: TEST_PRINCIPAL, asOf: '2026-09-15T09:00:00+08:00', fixtureDigest: 'fixture-test', taskId: 'task-cancelled',
      })
      const repository = new InvestigationRepository(store)
      const result = await runInvestigation({
        task, budgetConfig: TEST_BUDGET, repository, reports: new ReportRepository(resolve(root, 'reports'), store),
        model: new FakeModelTurnPort([]), dispatcher: new ScopedToolDispatcher({ client, budget: ledger }), ledger, signal: controller.signal,
      })
      expect(result.status).toBe('CANCELLED')
      expect(domainCalls).toBe(0)
      expect(repository.listEvents(result.runId).filter(event => event.type === 'RUN_COMPLETED')).toHaveLength(1)
    } finally { store.close() }
  })

  it('T30 completes fake-model + real stdio MCP + SQLite with an empty recommendation list', async () => {
    const root = temporaryRoot()
    const dbPath = resolve(root, 'runtime.sqlite')
    const reportDir = resolve(root, 'reports')
    const fixtureDir = resolve(import.meta.dir, '../../fixtures')
    const store = new CommerceDatabase(dbPath)
    const ledger = new BudgetLedger(TEST_BUDGET)
    try {
      const task = createInvestigationTask(COMPLETE_INPUT, {
        principal: TEST_PRINCIPAL, asOf: '2026-09-15T09:00:00+08:00', fixtureDigest: 'fixture-test', taskId: 'task-e2e',
      })
      const repository = new InvestigationRepository(store)
      const reports = new ReportRepository(reportDir, store)
      const result = await runInvestigation({
        task, budgetConfig: TEST_BUDGET, repository, reports, model: new ReactiveReportModel(task),
        dispatcher: new ScopedToolDispatcher({
          client: createScopedCommerceClient({ fixtureDir, shopId: 'demo-shop', reportDir, dbPath }), budget: ledger,
        }),
        ledger,
      })
      expect(result.status, JSON.stringify({ result, events: repository.listEvents(result.runId) })).toBe('REPORT_READY')
      expect(result.report?.status).toBe('UNRESOLVED')
      const report = await reports.get(result.report!.reportId)
      expect(report.recommendations).toEqual([])
      expect(repository.listEvents(result.runId).map(event => event.type)).toContain('REPORT_ACCEPTED')
    } finally { store.close() }
  }, 30_000)

  it('T26 records a rejected report and succeeds after one evidence-based repair', async () => {
    const root = temporaryRoot()
    const dbPath = resolve(root, 'runtime.sqlite')
    const reportDir = resolve(root, 'reports')
    const store = new CommerceDatabase(dbPath)
    const ledger = new BudgetLedger(TEST_BUDGET)
    try {
      const task = createInvestigationTask(COMPLETE_INPUT, {
        principal: TEST_PRINCIPAL, asOf: '2026-09-15T09:00:00+08:00', fixtureDigest: 'fixture-test', taskId: 'task-repair',
      })
      const repository = new InvestigationRepository(store)
      const result = await runInvestigation({
        task, budgetConfig: TEST_BUDGET, repository, reports: new ReportRepository(reportDir, store),
        model: new ReactiveReportModel(task, 1),
        dispatcher: new ScopedToolDispatcher({
          client: createScopedCommerceClient({ fixtureDir: resolve(import.meta.dir, '../../fixtures'), shopId: 'demo-shop', reportDir, dbPath }), budget: ledger,
        }), ledger,
      })
      expect(result.status).toBe('REPORT_READY')
      expect(repository.listEvents(result.runId).map(event => event.type)).toContain('REPORT_REJECTED')
      expect(ledger.snapshot().reportRepairs).toBe(1)
    } finally { store.close() }
  }, 30_000)

  it('T27 fails with REPORT_NOT_VALIDATED after exhausting report repairs', async () => {
    const root = temporaryRoot()
    const dbPath = resolve(root, 'runtime.sqlite')
    const reportDir = resolve(root, 'reports')
    const store = new CommerceDatabase(dbPath)
    const budget = { ...TEST_BUDGET, maxReportRepairs: 1 }
    const ledger = new BudgetLedger(budget)
    try {
      const task = createInvestigationTask(COMPLETE_INPUT, {
        principal: TEST_PRINCIPAL, asOf: '2026-09-15T09:00:00+08:00', fixtureDigest: 'fixture-test', taskId: 'task-repair-exhausted',
      })
      const result = await runInvestigation({
        task, budgetConfig: budget, repository: new InvestigationRepository(store), reports: new ReportRepository(reportDir, store),
        model: new ReactiveReportModel(task, 3),
        dispatcher: new ScopedToolDispatcher({
          client: createScopedCommerceClient({ fixtureDir: resolve(import.meta.dir, '../../fixtures'), shopId: 'demo-shop', reportDir, dbPath }), budget: ledger,
        }), ledger,
      })
      expect(result.status).toBe('FAILED')
      expect(result.error?.code).toBe('REPORT_NOT_VALIDATED')
      expect(result.report).toBeUndefined()
    } finally { store.close() }
  }, 30_000)
})
