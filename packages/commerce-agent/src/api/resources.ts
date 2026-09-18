import type { AuthenticatedPrincipal } from '../auth/contracts.ts'
import { requirePermission, requireShopAccess } from '../auth/authorization.ts'
import { CommerceError } from '../domain/errors.ts'
import type { EvidenceRepository } from '../evidence/evidence-repository.ts'
import type { ReportRepository } from '../reports/report-repository.ts'
import type { CommerceDatabase } from '../storage/database.ts'
import type { InvestigationRepository } from '../storage/investigation-repository.ts'
import type { ProposalRepository } from '../approvals/repository.ts'

function hidden(): never { throw new CommerceError('NOT_FOUND', 'Resource not found') }

type TaskListRow = {
  taskId: string; version: number; requestedBy: string; input: string; resolvedScope: string | null
  createdAt: string; updatedAt: string; runId: string | null; status: string | null; reportId: string | null
  completionReason: string | null; error: string | null
}

type ProposalSummaryRow = {
  proposalId: string; status: string; contentHash: string; actionType: string; targetId: string
  parameters: string; riskLevel: string; expectedImpact: string; rollbackPlan: string; expiresAt: string
  targetVersion: number; reviewStatus: string
}

export class ScopedResources {
  constructor(private readonly dependencies: {
    store: CommerceDatabase; investigations: InvestigationRepository; reports: ReportRepository
    evidence: EvidenceRepository; proposals: ProposalRepository
  }) {}

  async task(principal: AuthenticatedPrincipal, taskId: string) {
    requirePermission(principal, 'task:read')
    const task = await this.dependencies.investigations.getTask(taskId).catch(hidden)
    if (task.tenantId !== principal.tenantId) hidden()
    if (!task.resolvedScope) {
      if (task.requestedBy !== principal.actorId) hidden()
      return task
    }
    try { requireShopAccess(principal, task.resolvedScope.shopId) } catch { hidden() }
    return task
  }

  async events(principal: AuthenticatedPrincipal, taskId: string, cursor: number, limit: number) {
    const task = await this.task(principal, taskId)
    try {
      const run = await this.dependencies.investigations.getLatestRun(taskId)
      const events = this.dependencies.investigations.listEvents(run.runId).filter(event => event.sequence > cursor).slice(0, limit)
      return { items: events, nextCursor: events.at(-1)?.sequence ?? cursor, taskVersion: task.version, resetRequired: false }
    } catch (error) {
      if (error instanceof CommerceError && error.code === 'NOT_FOUND') return { items: [], nextCursor: cursor }
      throw error
    }
  }

  async tasks(principal: AuthenticatedPrincipal, options: { limit: number; before?: string }) {
    requirePermission(principal, 'task:read')
    if (principal.allowedShopIds.length === 0) return { items: [], nextBefore: undefined }
    const placeholders = principal.allowedShopIds.map(() => '?').join(',')
    const args: Array<string | number> = [principal.tenantId, ...principal.allowedShopIds, principal.actorId]
    let before = ''
    if (options.before) { before = ` AND t.updated_at < ?`; args.push(options.before) }
    args.push(options.limit)
    const items = this.dependencies.store.database.query<TaskListRow, Array<string | number>>(`SELECT
      t.task_id AS taskId,t.version,t.requested_by AS requestedBy,t.input_json AS input,t.resolved_scope_json AS resolvedScope,
      t.created_at AS createdAt,t.updated_at AS updatedAt,r.run_id AS runId,r.status,r.report_id AS reportId,
      r.completion_reason AS completionReason,r.error_json AS error
      FROM investigation_tasks t LEFT JOIN investigation_runs r ON r.run_id=(SELECT run_id FROM investigation_runs WHERE task_id=t.task_id ORDER BY attempt DESC LIMIT 1)
      WHERE t.tenant_id=? AND (json_extract(t.resolved_scope_json,'$.shopId') IN (${placeholders}) OR (t.resolved_scope_json IS NULL AND t.requested_by=?))${before}
      ORDER BY t.updated_at DESC LIMIT ?`).all(...args).map(row => ({
        ...row, input: JSON.parse(row.input as string), resolvedScope: row.resolvedScope ? JSON.parse(row.resolvedScope as string) : undefined,
        error: row.error ? JSON.parse(row.error as string) : undefined,
      }))
    return { items, nextBefore: items.length === options.limit ? items.at(-1)?.updatedAt as string | undefined : undefined }
  }

  async taskSnapshot(principal: AuthenticatedPrincipal, taskId: string) {
    const task = await this.task(principal, taskId)
    let run
    try { run = await this.dependencies.investigations.getLatestRun(taskId) } catch (error) {
      if (!(error instanceof CommerceError) || error.code !== 'NOT_FOUND') throw error
    }
    const events = run ? this.dependencies.investigations.listEvents(run.runId) : []
    const report = run?.reportId ? await this.report(principal, run.reportId) : undefined
    const reportVersion = run?.reportId ? this.dependencies.store.database.query<{ content_hash: string }, [string]>('SELECT content_hash FROM reports WHERE report_id=?1').get(run.reportId)?.content_hash : undefined
    const proposals = run?.reportId ? this.dependencies.store.database.query<ProposalSummaryRow, [string]>(
      'SELECT proposal_id AS proposalId,status,content_hash AS contentHash,action_type AS actionType,target_id AS targetId,params_json AS parameters,risk_level AS riskLevel,expected_impact AS expectedImpact,rollback_plan AS rollbackPlan,expires_at AS expiresAt,target_version AS targetVersion,review_status AS reviewStatus FROM proposals WHERE report_id=?1 ORDER BY created_at',
    ).all(run.reportId).map(item => ({ ...item, parameters: JSON.parse(item.parameters as string) })) : []
    const executions = proposals.flatMap(proposal => this.dependencies.store.database.query<Record<string, unknown>, [string]>(
      'SELECT request_id AS requestId,proposal_id AS proposalId,status,external_operation_id AS externalOperationId,result_json AS result,last_error AS lastError,updated_at AS updatedAt FROM commerce_execution_requests WHERE proposal_id=?1',
    ).all(proposal.proposalId as string).map(item => ({ ...item, result: item.result ? JSON.parse(item.result as string) : undefined })))
    return { snapshotVersion: `${task.version}:${run?.updatedAt ?? task.createdAt}`, task, run, events, report, reportVersion, proposals, executions }
  }

  async report(principal: AuthenticatedPrincipal, reportId: string) {
    requirePermission(principal, 'report:read')
    const scope = this.dependencies.store.database.query<{ tenant_id: string; shop_id: string }, [string]>(`
      SELECT t.tenant_id, json_extract(t.resolved_scope_json, '$.shopId') AS shop_id
      FROM investigation_runs r JOIN investigation_tasks t ON t.task_id = r.task_id
      WHERE r.report_id = ?1 LIMIT 1
    `).get(reportId)
    if (!scope || scope.tenant_id !== principal.tenantId || !principal.allowedShopIds.includes(scope.shop_id)) hidden()
    return this.dependencies.reports.get(reportId).catch(hidden)
  }

  evidence(principal: AuthenticatedPrincipal, evidenceId: string) {
    requirePermission(principal, 'evidence:read')
    for (const shopId of principal.allowedShopIds) {
      const record = this.dependencies.evidence.getScoped(evidenceId, { tenantId: principal.tenantId, shopId })
      if (record) return record
    }
    return hidden()
  }

  proposal(principal: AuthenticatedPrincipal, proposalId: string) {
    requirePermission(principal, 'proposal:read')
    const proposal = this.dependencies.proposals.get(proposalId)
    if (!proposal || proposal.tenantId !== principal.tenantId || !principal.allowedShopIds.includes(proposal.shopId)) hidden()
    return proposal
  }
}
