import { resolve } from 'node:path'
import { ApprovalService } from '../approvals/approval-service.ts'
import { ProposalRepository } from '../approvals/repository.ts'
import { ProposalService } from '../approvals/proposal-service.ts'
import {
  DIAGNOSIS_SKILL_SLUG,
  DIAGNOSIS_SOURCE_SLUG,
  runDiagnosisCase,
  type DiagnosisCaseName,
} from '../diagnosis/workflow.ts'
import { CommerceError } from '../domain/errors.ts'
import { ExecutionService } from '../execution/execution-service.ts'
import { MockExecutor } from '../execution/mock-executor.ts'
import { ReportRepository } from '../reports/report-repository.ts'
import { CommerceDatabase } from '../storage/database.ts'
import { CaseRepository, type CaseRun, type CaseRunState } from './case-repository.ts'

export type RecoveryRunnerOptions = {
  rootDir: string
  fixtureDir: string
  sessionId: string
  caseName: DiagnosisCaseName
  autoApprove?: boolean
  actor?: string
  stopAfter?: 'REPORT_READY' | 'PROPOSAL_PENDING' | 'EXECUTION_UNKNOWN'
  simulateResponseLoss?: boolean
  reconcileUnknown?: boolean
  timeoutMs?: number
  now?: () => Date
}

export type RecoveryRunResult = {
  sessionId: string
  caseName: DiagnosisCaseName
  status: CaseRunState
  reportId?: string
  proposalId?: string
  traceId: string
  parentTraceId?: string
  reportTraceId?: string
  replayed: boolean
  completionReason: string
  elapsedMs: number
  eventCount: number
}

function result(run: CaseRun, details: {
  reportTraceId?: string
  replayed: boolean
  completionReason: string
  elapsedMs: number
  eventCount: number
}): RecoveryRunResult {
  return {
    sessionId: run.sessionId,
    caseName: run.caseName,
    status: run.state,
    reportId: run.reportId,
    proposalId: run.proposalId,
    traceId: run.traceId,
    parentTraceId: run.parentTraceId,
    ...details,
  }
}

function proposalState(state: string): CaseRunState {
  if (state === 'PENDING_APPROVAL') return 'PROPOSAL_PENDING'
  if (state === 'APPROVED') return 'APPROVED'
  if (state === 'EXECUTING') return 'EXECUTING'
  if (state === 'SUCCEEDED') return 'SUCCEEDED'
  if (state === 'UNKNOWN') return 'UNKNOWN'
  return 'FAILED'
}

export async function runRecoverableCase(options: RecoveryRunnerOptions): Promise<RecoveryRunResult> {
  const startedAt = performance.now()
  const timeoutMs = options.timeoutMs ?? 30_000
  const now = options.now ?? (() => new Date())
  const dbPath = resolve(options.rootDir, 'commerce.sqlite')
  const reportDir = resolve(options.rootDir, 'reports')
  const store = new CommerceDatabase(dbPath)
  const cases = new CaseRepository(store)
  const reports = new ReportRepository(reportDir, store)
  const proposalRepository = new ProposalRepository(store)
  const proposals = new ProposalService({ reports, repository: proposalRepository, now })
  const approvals = new ApprovalService({ repository: proposalRepository, now })
  const mock = new MockExecutor({
    store,
    seedPath: resolve(options.fixtureDir, 'mock-platform-state.json'),
    now,
  })
  const executions = new ExecutionService({ repository: proposalRepository, executor: mock, now })
  let run = cases.createOrGet({ sessionId: options.sessionId, caseName: options.caseName, now: now().toISOString() })
  const replayed = run.runCount > 0
  run = cases.beginAttempt(run.sessionId, now().toISOString())

  const elapsed = () => Math.round((performance.now() - startedAt) * 100) / 100
  const complete = (completionReason: string, reportTraceId?: string): RecoveryRunResult => result(
    cases.getOrThrow(options.sessionId),
    {
      reportTraceId,
      replayed,
      completionReason,
      elapsedMs: elapsed(),
      eventCount: cases.listEvents(options.sessionId).length,
    },
  )
  const assertWithinDeadline = () => {
    if (performance.now() - startedAt > timeoutMs) {
      run = cases.update({
        sessionId: run.sessionId,
        state: 'TIMED_OUT',
        eventType: 'RUN_TIMED_OUT',
        lastError: `Exceeded ${timeoutMs}ms`,
        now: now().toISOString(),
      })
      throw new CommerceError('UPSTREAM_TIMEOUT', `Recoverable case exceeded ${timeoutMs}ms`)
    }
  }

  try {
    if (run.state === 'SUCCEEDED') return complete('Already succeeded; no side effect repeated.')

    let report = run.reportId ? await reports.get(run.reportId) : undefined
    if (!report) {
      run = cases.update({ sessionId: run.sessionId, state: 'DIAGNOSING', eventType: 'DIAGNOSIS_STARTED', now: now().toISOString() })
      assertWithinDeadline()
      const persisted = await runDiagnosisCase(options.caseName, {
        fixtureDir: options.fixtureDir,
        reportDir,
        dbPath,
        skillSlugs: [DIAGNOSIS_SKILL_SLUG],
        sourceSlugs: [DIAGNOSIS_SOURCE_SLUG],
      })
      report = persisted.report
      run = cases.update({
        sessionId: run.sessionId,
        state: 'REPORT_READY',
        reportId: report.reportId,
        eventType: 'REPORT_PERSISTED',
        details: { reportStatus: report.status, reportTraceId: report.traceId },
        now: now().toISOString(),
      })
    }
    assertWithinDeadline()
    if (options.stopAfter === 'REPORT_READY' || report.status !== 'RESOLVED') {
      return complete(report.status === 'RESOLVED' ? 'Stopped after validated report.' : `Report completed with ${report.status}.`, report.traceId)
    }

    let proposal = run.proposalId ? proposalRepository.getOrThrow(run.proposalId) : undefined
    if (!proposal) {
      proposal = await proposals.create({
        reportId: report.reportId,
        recommendationId: report.recommendations[0]!.recommendationId,
        expiresAt: new Date(now().getTime() + 24 * 60 * 60 * 1000).toISOString(),
      })
      run = cases.update({
        sessionId: run.sessionId,
        state: proposalState(proposal.status),
        proposalId: proposal.proposalId,
        eventType: 'PROPOSAL_LINKED',
        details: { proposalStatus: proposal.status },
        now: now().toISOString(),
      })
    }
    assertWithinDeadline()
    if (options.stopAfter === 'PROPOSAL_PENDING' || (!options.autoApprove && proposal.status === 'PENDING_APPROVAL')) {
      return complete('Waiting for an external operator decision.', report.traceId)
    }

    if (proposal.status === 'PENDING_APPROVAL') {
      proposal = approvals.approve({
        proposalId: proposal.proposalId,
        actor: options.actor ?? 'demo-operator',
        reason: 'Explicit operator approval in the recoverable demo runner.',
      })
      run = cases.update({ sessionId: run.sessionId, state: 'APPROVED', eventType: 'OPERATOR_APPROVED', now: now().toISOString() })
    }
    if (proposal.status === 'UNKNOWN') {
      if (!options.reconcileUnknown) return complete('Execution remains UNKNOWN pending reconciliation.', report.traceId)
      const reconciled = executions.reconcile({ proposalId: proposal.proposalId, actor: options.actor ?? 'demo-operator' })
      run = cases.update({
        sessionId: run.sessionId,
        state: reconciled.status,
        eventType: 'EXECUTION_RECONCILED',
        details: { reconciliation: reconciled.reason },
        now: now().toISOString(),
      })
      return complete(`Reconciled UNKNOWN to ${reconciled.status}.`, report.traceId)
    }
    if (proposal.status === 'SUCCEEDED') {
      run = cases.update({ sessionId: run.sessionId, state: 'SUCCEEDED', eventType: 'SUCCEEDED_REPLAYED', now: now().toISOString() })
      return complete('Existing successful execution reused.', report.traceId)
    }
    if (proposal.status !== 'APPROVED') {
      run = cases.update({ sessionId: run.sessionId, state: proposalState(proposal.status), eventType: 'NON_EXECUTABLE_PROPOSAL', now: now().toISOString() })
      return complete(`Proposal ended in ${proposal.status}.`, report.traceId)
    }

    run = cases.update({ sessionId: run.sessionId, state: 'EXECUTING', eventType: 'EXECUTION_DISPATCHED', now: now().toISOString() })
    const execution = executions.execute({
      proposalId: proposal.proposalId,
      actor: options.actor ?? 'demo-operator',
      simulateResponseLoss: options.simulateResponseLoss,
    })
    run = cases.update({
      sessionId: run.sessionId,
      state: proposalState(execution.proposal.status),
      eventType: execution.proposal.status === 'UNKNOWN' ? 'EXECUTION_UNKNOWN' : 'EXECUTION_TERMINAL',
      details: { operationId: execution.operation?.operationId, replayed: execution.replayed },
      now: now().toISOString(),
    })
    if (options.stopAfter === 'EXECUTION_UNKNOWN' || run.state !== 'UNKNOWN' || !options.reconcileUnknown) {
      return complete(`Execution reached ${run.state}.`, report.traceId)
    }
    const reconciled = executions.reconcile({ proposalId: proposal.proposalId, actor: options.actor ?? 'demo-operator' })
    run = cases.update({
      sessionId: run.sessionId,
      state: reconciled.status,
      eventType: 'EXECUTION_RECONCILED',
      details: { reconciliation: reconciled.reason },
      now: now().toISOString(),
    })
    return complete(`Reconciled UNKNOWN to ${reconciled.status}.`, report.traceId)
  } catch (error) {
    if (error instanceof CommerceError && error.code === 'UPSTREAM_TIMEOUT') throw error
    cases.update({
      sessionId: run.sessionId,
      state: 'FAILED',
      eventType: 'RUN_FAILED',
      lastError: error instanceof Error ? error.message : String(error),
      now: now().toISOString(),
    })
    throw error
  } finally {
    store.close()
  }
}
