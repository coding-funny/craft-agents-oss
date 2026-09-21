import { readFileSync } from 'node:fs'
import { contentDigest, type Proposal } from '../approvals/repository.ts'
import { CommerceError } from '../domain/errors.ts'
import type { CommerceDatabase } from '../storage/database.ts'

export type MockPlatformState = {
  campaigns: Record<string, { budgetMinor: number; currency: string; status: 'ACTIVE' | 'PAUSED'; version: number }>
  replenishmentTasks: Array<Record<string, unknown>>
  promotionTickets: Array<Record<string, unknown>>
}

export type MockOperation = {
  operationId: string
  idempotencyKey: string
  actionType: Proposal['actionType']
  targetId: string
  before: MockPlatformState
  after: MockPlatformState
  createdAt: string
}

type StateRow = { version: number; json: string }
type OperationRow = {
  operation_id: string; idempotency_key: string; action_type: Proposal['actionType']; target_id: string
  before_json: string; after_json: string; created_at: string
}

export class MockExecutor {
  readonly #store: CommerceDatabase
  readonly #now: () => Date

  constructor(options: { store: CommerceDatabase; seedPath: string; now?: () => Date }) {
    this.#store = options.store
    this.#now = options.now ?? (() => new Date())
    const existing = this.#store.database.query<StateRow, []>('SELECT version, json FROM mock_state WHERE state_key = \'platform\'').get()
    if (!existing) {
      const seed = JSON.parse(readFileSync(options.seedPath, 'utf8')) as MockPlatformState
      this.#store.database.query(
        'INSERT INTO mock_state (state_key, version, json, updated_at) VALUES (\'platform\', 1, ?1, ?2)',
      ).run(JSON.stringify(seed), this.#now().toISOString())
    }
  }

  getState(): MockPlatformState {
    const row = this.#store.database.query<StateRow, []>('SELECT version, json FROM mock_state WHERE state_key = \'platform\'').get()
    if (!row) throw new CommerceError('INTERNAL', 'Mock platform state is not initialized')
    return JSON.parse(row.json) as MockPlatformState
  }

  getOperation(idempotencyKey: string): MockOperation | undefined {
    const row = this.#store.database.query<OperationRow, [string]>(
      'SELECT * FROM mock_operations WHERE idempotency_key = ?1',
    ).get(idempotencyKey)
    return row ? {
      operationId: row.operation_id,
      idempotencyKey: row.idempotency_key,
      actionType: row.action_type,
      targetId: row.target_id,
      before: JSON.parse(row.before_json) as MockPlatformState,
      after: JSON.parse(row.after_json) as MockPlatformState,
      createdAt: row.created_at,
    } : undefined
  }

  apply(proposal: Proposal): MockOperation {
    const existing = this.getOperation(proposal.idempotencyKey)
    if (existing) return existing
    const transact = this.#store.database.transaction(() => {
      const repeated = this.getOperation(proposal.idempotencyKey)
      if (repeated) return repeated
      const before = this.getState()
      const after = structuredClone(before)
      this.#applyAction(after, proposal)
      const now = this.#now().toISOString()
      const operationId = `mockop_${contentDigest({ key: proposal.idempotencyKey, after }).slice(0, 24)}`
      this.#store.database.query(
        'UPDATE mock_state SET version = version + 1, json = ?1, updated_at = ?2 WHERE state_key = \'platform\'',
      ).run(JSON.stringify(after), now)
      this.#store.database.query(`
        INSERT INTO mock_operations (
          operation_id, idempotency_key, action_type, target_id, before_json, after_json, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
      `).run(operationId, proposal.idempotencyKey, proposal.actionType, proposal.targetId, JSON.stringify(before), JSON.stringify(after), now)
      return { operationId, idempotencyKey: proposal.idempotencyKey, actionType: proposal.actionType, targetId: proposal.targetId, before, after, createdAt: now }
    })
    return transact.immediate()
  }

  #applyAction(state: MockPlatformState, proposal: Proposal): void {
    if (proposal.actionType === 'ADJUST_AD_BUDGET') {
      const campaign = state.campaigns[proposal.targetId]
      if (!campaign) throw new CommerceError('NOT_FOUND', `Mock campaign not found: ${proposal.targetId}`)
      const expectedVersion = proposal.parameters.expectedVersion
      const newBudgetMinor = proposal.parameters.newBudgetMinor
      const currency = proposal.parameters.currency
      if (expectedVersion !== campaign.version) throw new CommerceError('INVALID_ARGUMENT', 'Mock campaign version changed')
      if (!Number.isSafeInteger(newBudgetMinor) || Number(newBudgetMinor) < 0 || currency !== campaign.currency) {
        throw new CommerceError('INVALID_ARGUMENT', 'Invalid mock budget parameters')
      }
      campaign.budgetMinor = Number(newBudgetMinor)
      campaign.version += 1
      return
    }
    if (proposal.actionType === 'PAUSE_AD_CAMPAIGN') {
      const campaign = state.campaigns[proposal.targetId]
      if (!campaign) throw new CommerceError('NOT_FOUND', `Mock campaign not found: ${proposal.targetId}`)
      if (proposal.parameters.expectedVersion !== campaign.version) {
        throw new CommerceError('INVALID_ARGUMENT', 'Mock campaign version changed')
      }
      campaign.status = 'PAUSED'
      campaign.version += 1
      return
    }
    if (proposal.actionType === 'CREATE_REPLENISHMENT_TASK') {
      state.replenishmentTasks.push({ ...proposal.parameters, taskId: `task-${proposal.proposalId}`, skuId: proposal.targetId })
      return
    }
    state.promotionTickets.push({ ...proposal.parameters, ticketId: `ticket-${proposal.proposalId}`, promotionId: proposal.targetId })
  }
}
