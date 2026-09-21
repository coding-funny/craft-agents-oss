import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { BudgetConfig } from '../contracts/runtime.ts'
import { createInvestigationTask } from '../contracts/task.ts'
import { CommerceError } from '../domain/errors.ts'
import type { IdentityRepository } from '../auth/repository.ts'
import type { OidcService } from '../auth/oidc.ts'
import { assertCsrf, authenticateSession, expiredSessionCookie, opaqueSecret, secretHash } from '../auth/session.ts'
import { requirePermission } from '../auth/authorization.ts'
import type { InvestigationRepository } from '../storage/investigation-repository.ts'
import type { ApprovalService } from '../approvals/approval-service.ts'
import { ApprovalDecisionRequestSchema, CreateTaskRequestSchema } from './contracts.ts'
import { RequestIdempotency } from './idempotency.ts'
import { ScopedResources } from './resources.ts'
import type { InvestigationTask } from '../contracts/task.ts'
import type { FeedbackService } from '../feedback/service.ts'
import type { MonitorRepository } from '../monitoring/repository.ts'
import { TaskListQuerySchema } from './contracts.ts'
import type { HealthService } from '../health/health-service.ts'
import type { CommerceMetrics } from '../observability/metrics.ts'

type CommerceApiOptions = {
  identity: IdentityRepository
  oidc: OidcService
  investigations: InvestigationRepository
  approvals: ApprovalService
  resources: ScopedResources
  idempotency: RequestIdempotency
  allowedOrigins: string[]
  asOf: string
  fixtureDigest: string
  budget: BudgetConfig
  now?: () => Date
  taskSink?: (task: InvestigationTask, now: string) => void
  feedback?: FeedbackService
  monitoring?: MonitorRepository
  health?: HealthService
  metrics?: CommerceMetrics
}

function routeId(pathname: string, prefix: string, suffix = ''): string | undefined {
  if (!pathname.startsWith(prefix) || (suffix && !pathname.endsWith(suffix))) return undefined
  const end = suffix ? -suffix.length : undefined
  const value = pathname.slice(prefix.length, end)
  return value && !value.includes('/') ? decodeURIComponent(value) : undefined
}

export class CommerceApi {
  readonly #options: CommerceApiOptions
  readonly #now: () => Date

  constructor(options: CommerceApiOptions) {
    this.#options = options
    this.#now = options.now ?? (() => new Date())
  }

  async fetch(request: Request): Promise<Response> {
    const traceId = `http_${randomUUID()}`
    const url = new URL(request.url)
    let principalResolved = false
    try {
      if (request.method === 'OPTIONS') return this.#cors(new Response(null, { status: 204 }), request)
      if (request.method === 'GET' && url.pathname === '/health/live') return this.#json(this.#options.health?.liveness() ?? { status: 'UP' })
      if (request.method === 'GET' && url.pathname === '/health/ready') {
        const result = this.#options.health?.readiness() ?? { status: 'NOT_READY', checks: { health: { ok: false, detail: 'health service unavailable' } } }
        return this.#json(result, result.status === 'READY' ? 200 : 503, { 'cache-control': 'no-store' })
      }
      if (request.method === 'GET' && url.pathname === '/metrics') {
        if (!this.#options.metrics) return new Response('metrics unavailable\n', { status: 503 })
        return new Response(this.#options.metrics.render(), { headers: { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store' } })
      }

      if (request.method === 'GET' && url.pathname === '/api/v1/auth/start') {
        const { authorizationUrl } = this.#options.oidc.begin(url.searchParams.get('tenant') ?? undefined)
        return this.#cors(new Response(null, { status: 302, headers: { location: authorizationUrl } }), request)
      }
      if (request.method === 'GET' && url.pathname === '/api/v1/auth/callback') {
        const result = await this.#options.oidc.callback({
          code: url.searchParams.get('code') ?? '', state: url.searchParams.get('state') ?? '',
        })
        if (request.headers.get('accept')?.includes('text/html')) {
          return this.#cors(new Response(null, { status: 302, headers: {
            location: '/commerce', 'set-cookie': result.setCookie, 'cache-control': 'no-store',
          } }), request)
        }
        return this.#cors(this.#json({ ok: true, data: { principal: result.principal, csrfToken: result.csrfToken }, traceId }, 200, {
          'set-cookie': result.setCookie,
          'cache-control': 'no-store',
        }), request)
      }

      const authenticated = authenticateSession(this.#options.identity, request, this.#now().toISOString())
      const principal = authenticated.principal
      principalResolved = true

      if (request.method === 'GET' && url.pathname === '/api/v1/me') {
        return this.#ok(principal, traceId, request)
      }
      if (request.method === 'GET' && url.pathname === '/api/v1/csrf-token') {
        if (!principal.sessionId) throw new CommerceError('SCOPE_DENIED', 'Browser session is required')
        const csrfToken = opaqueSecret()
        this.#options.identity.rotateSessionCsrf(principal.sessionId, secretHash(csrfToken))
        return this.#cors(this.#json({ ok: true, data: { csrfToken }, traceId }, 200, { 'cache-control': 'no-store' }), request)
      }
      if (request.method === 'POST' && url.pathname === '/api/v1/auth/logout') {
        assertCsrf(request, authenticated.csrfHash, this.#options.allowedOrigins)
        this.#options.identity.revokeSession(secretHash(authenticated.token), this.#now().toISOString())
        return this.#cors(this.#json({ ok: true, data: { loggedOut: true }, traceId }, 200, {
          'set-cookie': expiredSessionCookie(), 'cache-control': 'no-store',
        }), request)
      }
      if (request.method === 'POST' && url.pathname === '/api/v1/tasks') {
        assertCsrf(request, authenticated.csrfHash, this.#options.allowedOrigins)
        requirePermission(principal, 'task:create')
        const body = CreateTaskRequestSchema.parse(await request.json())
        const key = request.headers.get('idempotency-key') ?? ''
        const outcome = await this.#options.idempotency.execute({
          principal, operation: 'task:create', key, payload: body, now: this.#now().toISOString(),
          work: async () => {
            const task = createInvestigationTask(body.input, {
              principal: {
                actorId: principal.actorId, tenantId: principal.tenantId, allowedShopIds: principal.allowedShopIds,
                permissions: ['investigate', 'read_evidence', 'read_report'], authSource: principal.authSource,
              },
              asOf: this.#options.asOf, fixtureDigest: this.#options.fixtureDigest, now: this.#now,
            })
            await this.#options.investigations.createTask(
              task, this.#options.budget,
              this.#options.taskSink ? () => this.#options.taskSink!(task, this.#now().toISOString()) : undefined,
            )
            return task
          },
        })
        return this.#cors(this.#json({ ok: true, data: outcome.value, replayed: outcome.replayed, traceId }, outcome.replayed ? 200 : 201), request)
      }
      if (request.method === 'GET' && url.pathname === '/api/v1/tasks') {
        const query = TaskListQuerySchema.parse(Object.fromEntries([...url.searchParams].filter(([key]) => ['limit', 'before'].includes(key))))
        return this.#ok(await this.#options.resources.tasks(principal, query), traceId, request)
      }
      if (request.method === 'GET' && url.pathname === '/api/v1/cases') {
        requirePermission(principal, 'task:read')
        return this.#ok({ items: this.#options.monitoring?.list({ tenantId: principal.tenantId, shopIds: principal.allowedShopIds }) ?? [] }, traceId, request)
      }
      if (request.method === 'POST' && url.pathname === '/api/v1/feedback') {
        if (!this.#options.feedback) throw new CommerceError('INTERNAL', 'Feedback service is unavailable')
        assertCsrf(request, authenticated.csrfHash, this.#options.allowedOrigins)
        return this.#ok(this.#options.feedback.submit(principal, await request.json()), traceId, request)
      }
      if (request.method === 'GET' && url.pathname === '/api/v1/evaluation-candidates') {
        if (!this.#options.feedback) throw new CommerceError('INTERNAL', 'Feedback service is unavailable')
        return this.#ok({ items: this.#options.feedback.listCandidates(principal) }, traceId, request)
      }

      const taskEventsId = routeId(url.pathname, '/api/v1/tasks/', '/events')
      if (request.method === 'GET' && taskEventsId) {
        const cursor = Math.max(0, Number(url.searchParams.get('cursor') ?? 0) || 0)
        const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? 50) || 50))
        return this.#ok(await this.#options.resources.events(principal, taskEventsId, cursor, limit), traceId, request)
      }
      const taskSnapshotId = routeId(url.pathname, '/api/v1/tasks/', '/snapshot')
      if (request.method === 'GET' && taskSnapshotId) return this.#ok(await this.#options.resources.taskSnapshot(principal, taskSnapshotId), traceId, request)
      const taskId = routeId(url.pathname, '/api/v1/tasks/')
      if (request.method === 'GET' && taskId) return this.#ok(await this.#options.resources.task(principal, taskId), traceId, request)

      const reportId = routeId(url.pathname, '/api/v1/reports/')
      if (request.method === 'GET' && reportId) return this.#ok(await this.#options.resources.report(principal, reportId), traceId, request)
      const evidenceId = routeId(url.pathname, '/api/v1/evidence/')
      if (request.method === 'GET' && evidenceId) return this.#ok(this.#options.resources.evidence(principal, evidenceId), traceId, request)
      const proposalId = routeId(url.pathname, '/api/v1/proposals/')
      if (request.method === 'GET' && proposalId) return this.#ok(this.#options.resources.proposal(principal, proposalId), traceId, request)

      const approveId = routeId(url.pathname, '/api/v1/proposals/', '/approve')
      const rejectId = routeId(url.pathname, '/api/v1/proposals/', '/reject')
      if (request.method === 'POST' && (approveId || rejectId)) {
        assertCsrf(request, authenticated.csrfHash, this.#options.allowedOrigins)
        const proposal = this.#options.resources.proposal(principal, (approveId ?? rejectId)!)
        const body = ApprovalDecisionRequestSchema.parse(await request.json())
        const decided = approveId
          ? this.#options.approvals.approve({ proposalId: proposal.proposalId, principal, ...body })
          : this.#options.approvals.reject({ proposalId: proposal.proposalId, principal, ...body })
        return this.#ok(decided, traceId, request)
      }
      throw new CommerceError('NOT_FOUND', 'Route not found')
    } catch (error) {
      return this.#failure(error, traceId, request, principalResolved)
    }
  }

  #ok(data: unknown, traceId: string, request: Request): Response {
    return this.#cors(this.#json({ ok: true, data, traceId }), request)
  }

  #failure(error: unknown, traceId: string, request: Request, authenticated: boolean): Response {
    let status = 500
    let code = 'INTERNAL'
    let message = 'Internal server error'
    if (error instanceof z.ZodError) { status = 400; code = 'INVALID_ARGUMENT'; message = 'Request validation failed' }
    else if (error instanceof CommerceError) {
      code = error.code
      message = error.message
      if (error.code === 'NOT_FOUND') status = 404
      else if (error.code === 'SCOPE_DENIED') status = authenticated ? 403 : 401
      else if (error.code === 'INVALID_ARGUMENT') status = /race|Idempotency|pending approval|already/i.test(error.message) ? 409 : 400
      else status = 503
    }
    return this.#cors(this.#json({ ok: false, error: { code, message }, traceId }, status, { 'cache-control': 'no-store' }), request)
  }

  #json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
    return Response.json(value, { status, headers })
  }

  #cors(response: Response, request: Request): Response {
    const origin = request.headers.get('origin')
    if (origin && this.#options.allowedOrigins.includes(origin)) {
      response.headers.set('access-control-allow-origin', origin)
      response.headers.set('access-control-allow-credentials', 'true')
      response.headers.set('access-control-allow-headers', 'content-type,idempotency-key,x-csrf-token')
      response.headers.set('access-control-allow-methods', 'GET,POST,OPTIONS')
      response.headers.set('vary', 'Origin')
    }
    return response
  }
}
