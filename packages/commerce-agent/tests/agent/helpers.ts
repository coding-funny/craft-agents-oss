import type { BudgetConfig } from '../../src/contracts/runtime.ts'
import type { InvestigationInput, PrincipalContext } from '../../src/contracts/task.ts'
import { BASELINE_WINDOW, CURRENT_WINDOW } from '../helpers.ts'

export const TEST_BUDGET: BudgetConfig = {
  maxSteps: 10,
  maxModelRequests: 10,
  maxToolCalls: 16,
  maxToolAttempts: 20,
  maxParallelTools: 2,
  maxReportRepairs: 2,
  maxContextInputTokens: 20_000,
  maxOutputTokensPerRequest: 2_048,
  maxTotalInputTokens: 50_000,
  maxTotalOutputTokens: 20_000,
  runTimeoutMs: 20_000,
  toolTimeoutMs: 10_000,
  maxEstimatedCostMicros: 1_000_000,
  priceVersion: 'test-v1',
}

export const TEST_PRINCIPAL: PrincipalContext = {
  actorId: 'actor-test',
  tenantId: 'tenant-test',
  allowedShopIds: ['demo-shop'],
  permissions: ['investigate', 'read_evidence', 'read_report'],
  authSource: 'local-fixture',
}

export const COMPLETE_INPUT: InvestigationInput = {
  schemaVersion: 1,
  question: 'Investigate the sales change and check counter-evidence.',
  scope: {
    shopId: 'demo-shop',
    skuIds: ['SKU-A'],
    baselineWindow: BASELINE_WINDOW,
    currentWindow: CURRENT_WINDOW,
    currency: 'CNY',
  },
}
