import type { AuthenticatedPrincipal } from '../auth/contracts.ts'
import { requirePermission, requireShopAccess } from '../auth/authorization.ts'
import { CommerceError } from '../domain/errors.ts'
import type { EvidenceRepository } from '../evidence/evidence-repository.ts'
import type { ReportRepository } from '../reports/report-repository.ts'
import type { CommerceDatabase } from '../storage/database.ts'
import type { InvestigationRepository } from '../storage/investigation-repository.ts'
import type { ProposalRepository } from '../approvals/repository.ts'

function hidden(): never { throw new CommerceError('NOT_FOUND', 'Resource not found') }

export class ScopedResources {
  constructor(private readonly dependencies: {
    store: CommerceDatabase; investigations: InvestigationRepository; reports: ReportRepository
    evidence: EvidenceRepository; proposals: ProposalRepository
  }) {}

  async task(principal: AuthenticatedPrincipal, taskId: string) {
    requirePermission(principal, 'task:read')
    const task = await this.dependencies.investigations.getTask(taskId).catch(hidden)
    if (task.tenantId !== principal.tenantId || !task.resolvedScope) hidden()
    try { requireShopAccess(principal, task.resolvedScope.shopId) } catch { hidden() }
    return task
  }

  async events(principal: AuthenticatedPrincipal, taskId: string, cursor: number, limit: number) {
    await this.task(principal, taskId)
    try {
      const run = await this.dependencies.investigations.getLatestRun(taskId)
      const events = this.dependencies.investigations.listEvents(run.runId).filter(event => event.sequence > cursor).slice(0, limit)
      return { items: events, nextCursor: events.at(-1)?.sequence ?? cursor }
    } catch (error) {
      if (error instanceof CommerceError && error.code === 'NOT_FOUND') return { items: [], nextCursor: cursor }
      throw error
    }
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
