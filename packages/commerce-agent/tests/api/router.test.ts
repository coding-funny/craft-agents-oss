import { describe, expect, it } from 'bun:test'
import { ApprovalService } from '../../src/approvals/approval-service.ts'
import { ProposalRepository } from '../../src/approvals/repository.ts'
import { IdentityRepository } from '../../src/auth/repository.ts'
import { OidcService } from '../../src/auth/oidc.ts'
import { secretHash } from '../../src/auth/session.ts'
import type { BudgetConfig } from '../../src/contracts/runtime.ts'
import { EvidenceRepository } from '../../src/evidence/evidence-repository.ts'
import { ReportRepository } from '../../src/reports/report-repository.ts'
import { CommerceDatabase } from '../../src/storage/database.ts'
import { InvestigationRepository } from '../../src/storage/investigation-repository.ts'
import { RequestIdempotency } from '../../src/api/idempotency.ts'
import { ScopedResources } from '../../src/api/resources.ts'
import { CommerceApi } from '../../src/api/router.ts'

const NOW = new Date('2026-09-18T08:00:00.000Z')
const ORIGIN = 'https://ops.example.test'
const budget: BudgetConfig = {
  maxSteps: 8, maxModelRequests: 10, maxToolCalls: 16, maxToolAttempts: 24, maxParallelTools: 2,
  maxReportRepairs: 2, maxContextInputTokens: 12_000, maxOutputTokensPerRequest: 2_048,
  maxTotalInputTokens: 48_000, maxTotalOutputTokens: 12_000, runTimeoutMs: 120_000,
  toolTimeoutMs: 10_000, maxEstimatedCostMicros: 500_000, priceVersion: 'test-v1',
}

function input(question = '为什么销量下降？') {
  return { input: { schemaVersion: 1 as const, question, scope: {
    shopId: 'shop-a', skuIds: ['SKU-A'], currency: 'CNY' as const,
    baselineWindow: { start: '2026-09-01T00:00:00+08:00', end: '2026-09-08T00:00:00+08:00', timezone: 'Asia/Shanghai' },
    currentWindow: { start: '2026-09-08T00:00:00+08:00', end: '2026-09-15T00:00:00+08:00', timezone: 'Asia/Shanghai' },
  } } }
}

function harness() {
  const store = new CommerceDatabase(':memory:')
  const identity = new IdentityRepository(store)
  const investigations = new InvestigationRepository(store)
  const reports = new ReportRepository('/tmp/commerce-api-test-reports', store)
  const evidence = new EvidenceRepository(store)
  const proposals = new ProposalRepository(store)
  const now = NOW.toISOString()
  for (const tenant of ['tenant-a', 'tenant-b']) {
    identity.upsertMembership({ subject: `oidc|${tenant}`, actorId: `${tenant}-operator`, tenantId: tenant, roles: ['OPERATOR'], now })
    identity.setShopGrant({ subject: `oidc|${tenant}`, tenantId: tenant, shopId: 'shop-a', now })
  }
  const session = (tenant: string) => {
    const raw = `${tenant}-session-token`
    identity.createSession({
      tokenHash: secretHash(raw), csrfHash: secretHash(`${tenant}-csrf`), subject: `oidc|${tenant}`,
      tenantId: tenant, membershipVersion: 1, expiresAt: '2026-09-18T10:00:00.000Z', now,
    })
    return raw
  }
  const oidc = new OidcService({ repository: identity, config: {
    issuer: 'https://idp.invalid', audience: 'commerce-api', clientId: 'client',
    authorizationEndpoint: 'https://idp.invalid/authorize', tokenEndpoint: 'https://idp.invalid/token',
    jwksUri: 'https://idp.invalid/jwks', redirectUri: `${ORIGIN}/api/v1/auth/callback`,
  }, now: () => NOW })
  const resources = new ScopedResources({ store, investigations, reports, evidence, proposals })
  const api = new CommerceApi({
    identity, oidc, investigations, approvals: new ApprovalService({ repository: proposals, now: () => NOW }),
    resources, idempotency: new RequestIdempotency(store.database), allowedOrigins: [ORIGIN],
    asOf: NOW.toISOString(), fixtureDigest: 'a'.repeat(64), budget, now: () => NOW,
  })
  return { store, identity, api, tokenA: session('tenant-a'), tokenB: session('tenant-b') }
}

function request(path: string, options: { token?: string; csrf?: string; key?: string; body?: unknown; origin?: string } = {}) {
  const headers = new Headers()
  if (options.token) headers.set('cookie', `__Host-commerce_session=${options.token}`)
  if (options.csrf) headers.set('x-csrf-token', options.csrf)
  if (options.key) headers.set('idempotency-key', options.key)
  if (options.body) headers.set('content-type', 'application/json')
  if (options.origin) headers.set('origin', options.origin)
  return new Request(`https://api.example.test${path}`, {
    method: options.body ? 'POST' : 'GET', headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
}

describe('authenticated commerce API boundary', () => {
  it('requires authentication and rejects writes without valid CSRF', async () => {
    const { api, tokenA } = harness()
    expect((await api.fetch(request('/api/v1/me'))).status).toBe(401)
    const denied = await api.fetch(request('/api/v1/tasks', {
      token: tokenA, csrf: 'tenant-a-csrf', key: 'request-0001', body: input(), origin: 'https://evil.test',
    }))
    expect(denied.status).toBe(403)
  })

  it('creates a scoped task idempotently and hides it from another tenant', async () => {
    const { api, tokenA, tokenB } = harness()
    const options = { token: tokenA, csrf: 'tenant-a-csrf', key: 'request-0002', body: input(), origin: ORIGIN }
    const created = await api.fetch(request('/api/v1/tasks', options))
    expect(created.status).toBe(201)
    const first = await created.json() as { data: { taskId: string }; replayed: boolean }
    const replay = await api.fetch(request('/api/v1/tasks', options))
    expect(replay.status).toBe(200)
    expect((await replay.json() as { replayed: boolean }).replayed).toBe(true)
    expect((await api.fetch(request(`/api/v1/tasks/${first.data.taskId}`, { token: tokenB }))).status).toBe(404)
    expect((await api.fetch(request(`/api/v1/tasks/${first.data.taskId}`, { token: tokenA }))).status).toBe(200)
  })

  it('returns conflict when an idempotency key is reused with changed input', async () => {
    const { api, tokenA } = harness()
    const common = { token: tokenA, csrf: 'tenant-a-csrf', key: 'request-0003', origin: ORIGIN }
    expect((await api.fetch(request('/api/v1/tasks', { ...common, body: input() }))).status).toBe(201)
    expect((await api.fetch(request('/api/v1/tasks', { ...common, body: input('换一个问题') }))).status).toBe(409)
  })

  it('rejects a same-tenant shop that is absent from server-side grants', async () => {
    const { api, tokenA } = harness()
    const body = input()
    body.input.scope.shopId = 'shop-b'
    const response = await api.fetch(request('/api/v1/tasks', {
      token: tokenA, csrf: 'tenant-a-csrf', key: 'request-0004', body, origin: ORIGIN,
    }))
    expect(response.status).toBe(403)
  })

  it('invalidates existing cookies after membership version changes', async () => {
    const { api, identity, tokenA } = harness()
    identity.upsertMembership({
      subject: 'oidc|tenant-a', actorId: 'tenant-a-operator', tenantId: 'tenant-a', roles: ['OPERATOR'], now: NOW.toISOString(),
    })
    expect((await api.fetch(request('/api/v1/me', { token: tokenA }))).status).toBe(401)
  })

  it('issues a rotated CSRF token without exposing the session secret', async () => {
    const { api, tokenA } = harness()
    const issued = await api.fetch(request('/api/v1/csrf-token', { token: tokenA }))
    expect(issued.status).toBe(200)
    const csrfToken = (await issued.json() as { data: { csrfToken: string } }).data.csrfToken
    expect(csrfToken).not.toContain(tokenA)
    expect((await api.fetch(request('/api/v1/tasks', { token: tokenA, csrf: 'tenant-a-csrf', key: 'request-old-csrf', body: input(), origin: ORIGIN }))).status).toBe(403)
    expect((await api.fetch(request('/api/v1/tasks', { token: tokenA, csrf: csrfToken, key: 'request-new-csrf', body: input(), origin: ORIGIN }))).status).toBe(201)
  })

  it('lists scoped tasks and returns a refresh-safe workbench snapshot', async () => {
    const { api, tokenA, tokenB } = harness()
    const created = await api.fetch(request('/api/v1/tasks', { token: tokenA, csrf: 'tenant-a-csrf', key: 'request-workbench', body: input(), origin: ORIGIN }))
    const taskId = (await created.json() as { data: { taskId: string } }).data.taskId
    const list = await api.fetch(request('/api/v1/tasks?limit=30', { token: tokenA }))
    expect((await list.json() as { data: { items: Array<{ taskId: string }> } }).data.items.map(item => item.taskId)).toEqual([taskId])
    const snapshot = await api.fetch(request(`/api/v1/tasks/${taskId}/snapshot`, { token: tokenA }))
    const body = await snapshot.json() as { data: { snapshotVersion: string; events: unknown[]; task: { taskId: string } } }
    expect(body.data.task.taskId).toBe(taskId)
    expect(body.data.snapshotVersion).toContain(':')
    expect(body.data.events).toEqual([])
    expect((await api.fetch(request('/api/v1/tasks?limit=30', { token: tokenB }))).status).toBe(200)
  })
})
