import { randomUUID } from 'node:crypto'
import type { BudgetConfig, InvestigationResult, RunManifest, UsageRecord } from '../contracts/runtime.ts'
import type { ClarificationRequest, InvestigationTask } from '../contracts/task.ts'
import { CommerceError } from '../domain/errors.ts'
import { redactErrorMessage } from '../mcp/trace.ts'
import type { ReportRepository } from '../reports/report-repository.ts'
import type { InvestigationRepository, RunRecord } from '../storage/investigation-repository.ts'
import { BudgetLedger } from './budget.ts'
import { buildContext } from './context-manager.ts'
import { LoopDetector } from './loop-detector.ts'
import type { CompletedTurn, ModelMessage, ModelTurnPort } from './model-port.ts'
import { commerceSystemPrompt, COMMERCE_INVESTIGATION_PROMPT_VERSION } from './prompts/commerce-investigation.ts'
import { ScopedToolDispatcher, type TrustedRunContext } from './tool-dispatcher.ts'

export type InvestigationRunnerOptions = {
  task: InvestigationTask
  budgetConfig: BudgetConfig
  repository: InvestigationRepository
  reports: ReportRepository
  model: ModelTurnPort
  dispatcher: ScopedToolDispatcher
  ledger: BudgetLedger
  parentRunId?: string
  now?: () => Date
  signal?: AbortSignal
}

const ZERO_USAGE: UsageRecord = {
  inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costMicros: 0, source: 'actual',
}

function errorInfo(error: unknown): NonNullable<InvestigationResult['error']> {
  if (error instanceof CommerceError) {
    return { code: error.code, retryable: error.code === 'RATE_LIMITED' || error.code === 'UPSTREAM_TIMEOUT', message: redactErrorMessage(error.message) }
  }
  return { code: 'INTERNAL', retryable: false, message: redactErrorMessage(error instanceof Error ? error.message : String(error)) }
}

async function finalTurn(model: ModelTurnPort, request: Parameters<ModelTurnPort['generate']>[0], signal: AbortSignal): Promise<CompletedTurn> {
  let completed: CompletedTurn | undefined
  for await (const event of model.generate(request, signal)) {
    if (event.type === 'turn_error') throw new CommerceError(
      event.code === 'ABORTED' ? 'UPSTREAM_TIMEOUT' : 'PROVIDER_UNAVAILABLE', event.message,
    )
    if (event.type === 'turn_complete') completed = event.turn
  }
  if (!completed) throw new CommerceError('MODEL_PROTOCOL_ERROR', 'Model stream ended without a completed turn')
  if (completed.stopReason === 'length') throw new CommerceError('MODEL_PROTOCOL_ERROR', 'Model response was truncated')
  return completed
}

function manifest(options: InvestigationRunnerOptions, run: RunRecord, ledger: BudgetLedger, reason: string): RunManifest {
  const description = options.model.describe()
  const budget = ledger.snapshot()
  return {
    schemaVersion: 1,
    manifestId: `manifest_${randomUUID()}`,
    driver: description.driver,
    modelId: description.modelId,
    modelVersion: description.modelVersion,
    modelMode: description.mode,
    promptVersion: COMMERCE_INVESTIGATION_PROMPT_VERSION,
    toolVersion: 'commerce-scoped-tools-v1',
    schemaVersionName: 'commerce-investigation-schema-v1',
    fixtureDigest: options.task.fixtureDigest,
    usage: budget.usage ?? ZERO_USAGE,
    steps: budget.steps,
    modelRequests: budget.modelRequests,
    toolCalls: budget.toolCalls,
    toolAttempts: budget.toolAttempts,
    reportRepairs: budget.reportRepairs,
    completionReason: reason,
  }
}

function resultFromRun(run: RunRecord): InvestigationResult {
  return {
    schemaVersion: 1,
    taskId: run.taskId,
    runId: run.runId,
    traceId: run.traceId,
    status: run.status,
    report: run.reportId && run.manifest ? { reportId: run.reportId, status: run.manifest.reportStatus ?? 'UNRESOLVED' } : undefined,
    clarification: run.clarification,
    completionReason: run.completionReason ?? 'Run has not completed.',
    error: run.error,
    manifestId: run.manifest?.manifestId ?? 'manifest_unavailable',
  }
}

export async function runInvestigation(options: InvestigationRunnerOptions): Promise<InvestigationResult> {
  const now = options.now ?? (() => new Date())
  const ledger = options.ledger
  const loop = new LoopDetector(3)
  const controller = new AbortController()
  const externalAbort = () => controller.abort(options.signal?.reason)
  options.signal?.addEventListener('abort', externalAbort, { once: true })
  const timeout = setTimeout(() => controller.abort(new Error('run deadline exceeded')), options.budgetConfig.runTimeoutMs)
  let run: RunRecord | undefined

  try {
    await options.repository.createTask(options.task, options.budgetConfig)
    run = await options.repository.createRun(options.task.taskId, { parentRunId: options.parentRunId, now: now().toISOString() })
    if (!options.task.resolvedScope) {
      const scope = options.task.input.scope
      const fields = [
        !scope?.shopId ? 'scope.shopId' : '', !scope?.skuIds?.length ? 'scope.skuIds' : '',
        !scope?.baselineWindow ? 'scope.baselineWindow' : '', !scope?.currentWindow ? 'scope.currentWindow' : '',
      ].filter(Boolean)
      const clarification: ClarificationRequest = {
        requestId: `clarification_${randomUUID()}`, expectedTaskVersion: options.task.version,
        fields, question: `Please provide: ${fields.join(', ')}`,
      }
      const reason = 'Required task scope is missing.'
      run = await options.repository.transition({
        runId: run.runId, expected: 'QUEUED', status: 'WAITING_INPUT', now: now().toISOString(),
        eventType: 'CLARIFICATION_REQUESTED', clarification, completionReason: reason,
        manifest: manifest(options, run, ledger, reason),
      })
      return resultFromRun(run)
    }

    await options.dispatcher.initialize()
    run = await options.repository.transition({
      runId: run.runId, expected: 'QUEUED', status: 'RUNNING', now: now().toISOString(), eventType: 'RUN_STARTED',
    })
    const context: TrustedRunContext = {
      runId: run.runId, taskId: options.task.taskId, traceId: run.traceId, asOf: options.task.asOf,
      scope: options.task.resolvedScope, signal: controller.signal, toolTimeoutMs: options.budgetConfig.toolTimeoutMs,
    }
    const messages: ModelMessage[] = [{ role: 'user', content: options.task.input.question }]
    let unvalidatedStops = 0

    while (run.status === 'RUNNING') {
      if (controller.signal.aborted) throw new CommerceError('UPSTREAM_TIMEOUT', 'Investigation run deadline or cancellation reached')
      ledger.reserveModel()
      await options.repository.appendEvent({ runId: run.runId, type: 'MODEL_REQUESTED', createdAt: now().toISOString() })
      const turn = await finalTurn(options.model, {
        systemPrompt: commerceSystemPrompt(options.task),
        messages: buildContext(messages, options.dispatcher.state(), options.budgetConfig.maxContextInputTokens),
        tools: options.dispatcher.definitions(), maxOutputTokens: options.budgetConfig.maxOutputTokensPerRequest,
      }, controller.signal)
      ledger.settleModel(turn.usage)
      await options.repository.appendEvent({ runId: run.runId, type: 'MODEL_COMPLETED', payload: { requestId: turn.requestId, toolCount: turn.toolCalls.length, usage: turn.usage }, createdAt: now().toISOString() })
      messages.push({ role: 'assistant', content: turn.text, toolCalls: turn.toolCalls })

      if (turn.toolCalls.length === 0) {
        unvalidatedStops += 1
        if (unvalidatedStops >= 2) throw new CommerceError('REPORT_NOT_VALIDATED', 'Model stopped without a validated report')
        messages.push({ role: 'user', content: 'The run is not complete. Use validate_report, request_clarification, or continue investigating.' })
        continue
      }

      options.dispatcher.preflight(turn.toolCalls, context)
      for (const call of turn.toolCalls) {
        const before = new Set(options.dispatcher.state().evidenceIds)
        await options.repository.appendEvent({ runId: run.runId, type: 'TOOL_REQUESTED', payload: { callId: call.callId, name: call.name }, createdAt: now().toISOString() })
        let dispatched
        try {
          dispatched = await options.dispatcher.dispatch(call, context)
        } catch (error) {
          if (error instanceof CommerceError && ['INVALID_ARGUMENT', 'UPSTREAM_TIMEOUT', 'RATE_LIMITED', 'INTERNAL', 'REPORT_NOT_VALIDATED'].includes(error.code)) {
            if (call.name === 'validate_report') ledger.recordReportRepair()
            const info = errorInfo(error)
            messages.push({ role: 'tool', toolCallId: call.callId, toolName: call.name, content: JSON.stringify({ status: 'error', error: info }), isError: true })
            await options.repository.appendEvent({ runId: run.runId, type: call.name === 'validate_report' ? 'REPORT_REJECTED' : 'TOOL_COMPLETED', payload: { callId: call.callId, name: call.name, error: info }, createdAt: now().toISOString() })
            continue
          }
          throw error
        }
        const after = options.dispatcher.state().evidenceIds
        messages.push({ role: 'tool', toolCallId: call.callId, toolName: call.name, content: dispatched.content, isError: dispatched.isError })
        await options.repository.appendEvent({ runId: run.runId, type: 'TOOL_COMPLETED', payload: { callId: call.callId, name: call.name, isError: dispatched.isError, evidenceIds: dispatched.evidenceIds }, createdAt: now().toISOString() })

        if (dispatched.isError && call.name === 'validate_report') {
          ledger.recordReportRepair()
          await options.repository.appendEvent({
            runId: run.runId, type: 'REPORT_REJECTED',
            payload: { callId: call.callId, response: dispatched.content.slice(0, 2_000) }, createdAt: now().toISOString(),
          })
          continue
        }
        loop.observe(options.dispatcher.fingerprint(call, context), after.some(id => !before.has(id)))

        if (dispatched.clarification) {
          const clarification: ClarificationRequest = {
            requestId: `clarification_${randomUUID()}`, expectedTaskVersion: options.task.version,
            fields: dispatched.clarification.fields, question: dispatched.clarification.question,
          }
          const reason = 'The model requested missing task scope.'
          run = await options.repository.transition({
            runId: run.runId, expected: 'RUNNING', status: 'WAITING_INPUT', now: now().toISOString(),
            eventType: 'CLARIFICATION_REQUESTED', clarification, completionReason: reason,
            manifest: manifest(options, run, ledger, reason),
          })
          break
        }
        if (dispatched.reportId) {
          const report = await options.reports.get(dispatched.reportId)
          if (report.caseId !== options.task.taskId || report.traceId !== run.traceId || report.scope.shopId !== context.scope.shopId) {
            throw new CommerceError('REPORT_NOT_VALIDATED', 'Persisted report does not belong to this run')
          }
          const reason = 'Validated report persisted and read back.'
          const runManifest = manifest(options, run, ledger, reason)
          runManifest.reportStatus = report.status
          run = await options.repository.transition({
            runId: run.runId, expected: 'RUNNING', status: 'REPORT_READY', now: now().toISOString(),
            eventType: 'REPORT_ACCEPTED', reportId: report.reportId, completionReason: reason, manifest: runManifest,
          })
          break
        }
      }
      await options.repository.checkpoint({ runId: run.runId, state: options.dispatcher.state(), budget: ledger.snapshot(), now: now().toISOString() })
    }
    return resultFromRun(run)
  } catch (error) {
    if (!run) throw error
    const info = errorInfo(error)
    const status = options.signal?.aborted ? 'CANCELLED' : controller.signal.aborted ? 'TIMED_OUT' : 'FAILED'
    const current = await options.repository.getRun(run.runId)
    if (current.status === 'RUNNING' || current.status === 'QUEUED') {
      run = await options.repository.transition({
        runId: run.runId, expected: current.status, status, now: now().toISOString(), eventType: 'RUN_COMPLETED',
        error: info, completionReason: info.message, manifest: manifest(options, current, ledger, info.message),
      })
    } else run = current
    return resultFromRun(run)
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', externalAbort)
    await Promise.allSettled([options.dispatcher.close(), options.model.close()])
  }
}
