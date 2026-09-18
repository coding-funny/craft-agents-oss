import { resolve } from 'node:path'
import { ApprovalService } from '../approvals/approval-service.ts'
import { ProposalRepository } from '../approvals/repository.ts'
import { ProposalService } from '../approvals/proposal-service.ts'
import { ExecutionService } from '../execution/execution-service.ts'
import { MockExecutor } from '../execution/mock-executor.ts'
import { ReportRepository } from '../reports/report-repository.ts'
import { CommerceDatabase } from '../storage/database.ts'
import { localTestPrincipal } from '../auth/local-test.ts'

export function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

export function hasFlag(name: string): boolean {
  return process.argv.includes(name)
}

export function createCliRuntime(options: { now?: () => Date } = {}) {
  if (process.env.COMMERCE_AUTH_MODE !== 'local-test') {
    throw new Error('Approval and execution CLIs are disabled outside COMMERCE_AUTH_MODE=local-test; use the authenticated API')
  }
  const artifactDir = process.env.COMMERCE_REPORT_DIR ?? resolve(import.meta.dir, '../../demo/artifacts')
  const dbPath = argument('--db') ?? process.env.COMMERCE_DB_PATH ?? resolve(artifactDir, 'commerce.sqlite')
  const mockSeedPath = process.env.COMMERCE_MOCK_STATE_FIXTURE ?? resolve(import.meta.dir, '../../fixtures/mock-platform-state.json')
  const store = new CommerceDatabase(dbPath)
  const reports = new ReportRepository(artifactDir, store)
  const repository = new ProposalRepository(store)
  const proposals = new ProposalService({ reports, repository, now: options.now })
  const approvals = new ApprovalService({ repository, now: options.now })
  const executor = new MockExecutor({ store, seedPath: mockSeedPath, now: options.now })
  const executions = new ExecutionService({ repository, executor, now: options.now })
  const operatorPrincipal = localTestPrincipal({ actorId: 'local-requester', roles: ['OPERATOR'] })
  const approverPrincipal = localTestPrincipal({ actorId: 'local-approver', roles: ['APPROVER'] })
  const executorPrincipal = localTestPrincipal({ actorId: 'local-executor', roles: ['EXECUTOR'], authSource: 'service-identity' })
  return { store, reports, repository, proposals, approvals, executor, executions, operatorPrincipal, approverPrincipal, executorPrincipal }
}

export function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2))
}

export function failCli(error: unknown): never {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
