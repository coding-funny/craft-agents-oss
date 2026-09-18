#!/usr/bin/env bun
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'
import { BudgetLedger } from '../agent/budget.ts'
import { runInvestigation } from '../agent/investigation-runner.ts'
import { ScopedToolDispatcher } from '../agent/tool-dispatcher.ts'
import { fixtureDigest, loadInvestigationConfig } from '../config/investigation.ts'
import { createInvestigationTask, InvestigationInputSchema, resolveScope, type InvestigationTask } from '../contracts/task.ts'
import { CommerceError } from '../domain/errors.ts'
import { createScopedCommerceClient } from '../mcp/scoped-client.ts'
import { ReportRepository } from '../reports/report-repository.ts'
import { CommerceDatabase } from '../storage/database.ts'
import { InvestigationRepository } from '../storage/investigation-repository.ts'
import { SqliteDataGovernanceRepository } from '../storage/sqlite-data-governance-repository.ts'
import { contentHash } from '../data/hash.ts'
import { createConfiguredModel } from './investigation-runtime.ts'

function valueFor(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function exitCode(status: string): number {
  if (status === 'REPORT_READY') return 0
  if (status === 'WAITING_INPUT') return 2
  if (status === 'TIMED_OUT') return 124
  if (status === 'CANCELLED') return 130
  return 1
}

export async function investigateCli(): Promise<number> {
  const inputPath = valueFor('--input')
  const continueTaskId = valueFor('--continue-task')
  const answersPath = valueFor('--answers')
  const configPath = valueFor('--config')
  if (!configPath || Boolean(inputPath) === Boolean(continueTaskId) || (continueTaskId && !answersPath)) {
    throw new CommerceError('INVALID_ARGUMENT', 'Use either --input <task.json> or --continue-task <task-id> --answers <answers.json>, plus --config')
  }
  const config = await loadInvestigationConfig(configPath)
  const store = new CommerceDatabase(config.dbPath)
  const controller = new AbortController()
  const abort = () => controller.abort(new Error('process interrupted'))
  process.once('SIGINT', abort)
  process.once('SIGTERM', abort)
  try {
    const repository = new InvestigationRepository(store)
    let task: InvestigationTask
    let parentRunId: string | undefined
    let initialBudget: ConstructorParameters<typeof BudgetLedger>[1]
    let digest: string
    if (config.dataMode === 'fixture') digest = await fixtureDigest(config.fixtureDir)
    else {
      const snapshot = await new SqliteDataGovernanceRepository(store).getSnapshot({
        tenantId: config.principal.tenantId,
        shopId: config.snapshotShopId,
        snapshotId: config.snapshotId,
      })
      if (!snapshot) throw new CommerceError('NOT_FOUND', 'Configured imported snapshot was not found in the runtime database')
      digest = contentHash(snapshot)
    }
    if (inputPath) {
      const input = JSON.parse(await readFile(resolve(inputPath), 'utf8'))
      task = createInvestigationTask(input, {
        principal: config.principal, asOf: config.asOf, fixtureDigest: digest,
      })
    } else {
      const current = await repository.getTask(continueTaskId!)
      const parent = await repository.getLatestRun(current.taskId)
      if (parent.status !== 'WAITING_INPUT' || !parent.clarification) {
        throw new CommerceError('INVALID_ARGUMENT', 'Only the latest WAITING_INPUT run can be continued')
      }
      const AnswerSchema = z.object({
        expectedTaskVersion: z.number().int().min(1),
        scope: z.object({
          shopId: z.string().min(1).optional(), skuIds: z.array(z.string().min(1)).min(1).max(20).optional(),
          baselineWindow: z.object({ start: z.string(), end: z.string(), timezone: z.string() }).strict().optional(),
          currentWindow: z.object({ start: z.string(), end: z.string(), timezone: z.string() }).strict().optional(),
          currency: z.literal('CNY').optional(),
        }).strict(),
      }).strict()
      const answer = AnswerSchema.parse(JSON.parse(await readFile(resolve(answersPath!), 'utf8')))
      if (answer.expectedTaskVersion !== current.version || answer.expectedTaskVersion !== parent.clarification.expectedTaskVersion) {
        throw new CommerceError('INVALID_ARGUMENT', 'Clarification answer targets a stale task version')
      }
      if (current.tenantId !== config.principal.tenantId) throw new CommerceError('SCOPE_DENIED', 'Task tenant differs from trusted principal')
      const input = InvestigationInputSchema.parse({
        ...current.input,
        scope: { ...(current.input.scope ?? {}), ...answer.scope },
      })
      const { scope } = resolveScope(input, config.principal)
      task = {
        ...current, version: current.version + 1, requestedBy: config.principal.actorId,
        input, resolvedScope: scope, asOf: config.asOf, fixtureDigest: digest, createdAt: new Date().toISOString(),
      }
      parentRunId = parent.runId
      if (parent.manifest) {
        initialBudget = {
          steps: parent.manifest.steps,
          modelRequests: parent.manifest.modelRequests,
          toolCalls: parent.manifest.toolCalls,
          toolAttempts: parent.manifest.toolAttempts,
          reportRepairs: parent.manifest.reportRepairs,
          usage: parent.manifest.usage,
        }
      }
    }
    const reports = new ReportRepository(config.reportDir, store)
    const ledger = new BudgetLedger(config.budget, initialBudget)
    const dispatcher = new ScopedToolDispatcher({
      client: createScopedCommerceClient({
        shopId: task.resolvedScope?.shopId ?? config.principal.allowedShopIds[0]!,
        reportDir: config.reportDir,
        dbPath: config.dbPath,
        requestedBy: task.requestedBy,
        traceFile: config.traceFile,
        ...(config.dataMode === 'fixture'
          ? { dataMode: 'fixture' as const, fixtureDir: config.fixtureDir }
          : { dataMode: 'imported' as const, tenantId: config.principal.tenantId, snapshotId: config.snapshotId }),
      }),
      budget: ledger,
    })
    const result = await runInvestigation({
      task, budgetConfig: config.budget, repository, reports,
      model: await createConfiguredModel(config), dispatcher, ledger, parentRunId, signal: controller.signal,
    })
    process.stdout.write(`${JSON.stringify(result)}\n`)
    return exitCode(result.status)
  } finally {
    process.removeListener('SIGINT', abort)
    process.removeListener('SIGTERM', abort)
    store.close()
  }
}

if (import.meta.main) {
  investigateCli().then(code => { process.exitCode = code }).catch(error => {
    const normalized = error instanceof CommerceError
      ? { code: error.code, message: error.message }
      : { code: 'INTERNAL', message: error instanceof Error ? error.message : String(error) }
    process.stdout.write(`${JSON.stringify({ error: normalized })}\n`)
    process.exitCode = 1
  })
}
