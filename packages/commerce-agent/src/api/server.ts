#!/usr/bin/env bun
import { resolve } from 'node:path'
import { ApprovalService } from '../approvals/approval-service.ts'
import { ProposalRepository } from '../approvals/repository.ts'
import { IdentityRepository } from '../auth/repository.ts'
import { OidcService } from '../auth/oidc.ts'
import type { BudgetConfig } from '../contracts/runtime.ts'
import { EvidenceRepository } from '../evidence/evidence-repository.ts'
import { ReportRepository } from '../reports/report-repository.ts'
import { CommerceDatabase } from '../storage/database.ts'
import { InvestigationRepository } from '../storage/investigation-repository.ts'
import { RequestIdempotency } from './idempotency.ts'
import { ScopedResources } from './resources.ts'
import { CommerceApi } from './router.ts'
import { DurableJobRepository } from '../jobs/repository.ts'
import { OutboxRepository } from '../jobs/outbox.ts'
import { createApprovalDecisionSink, createTaskJobSink } from '../jobs/integration.ts'
import { FeedbackService } from '../feedback/service.ts'
import { MonitorRepository } from '../monitoring/repository.ts'
import { HealthService } from '../health/health-service.ts'
import { CommerceMetrics } from '../observability/metrics.ts'

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

const DEFAULT_BUDGET: BudgetConfig = {
  maxSteps: 8, maxModelRequests: 10, maxToolCalls: 16, maxToolAttempts: 24,
  maxParallelTools: 2, maxReportRepairs: 2, maxContextInputTokens: 12_000,
  maxOutputTokensPerRequest: 2_048, maxTotalInputTokens: 48_000, maxTotalOutputTokens: 12_000,
  runTimeoutMs: 120_000, toolTimeoutMs: 10_000, maxEstimatedCostMicros: 500_000,
  priceVersion: 'commerce-api-v1',
}

export function createApiFromEnvironment(): { api: CommerceApi; store: CommerceDatabase } {
  const artifactDir = process.env.COMMERCE_REPORT_DIR ?? resolve(import.meta.dir, '../../demo/artifacts')
  const store = new CommerceDatabase(process.env.COMMERCE_DB_PATH ?? resolve(artifactDir, 'commerce.sqlite'))
  const identity = new IdentityRepository(store)
  const investigations = new InvestigationRepository(store)
  const reports = new ReportRepository(artifactDir, store)
  const evidence = new EvidenceRepository(store)
  const proposals = new ProposalRepository(store)
  const jobs = new DurableJobRepository(store)
  const outbox = new OutboxRepository(store)
  const approvals = new ApprovalService({ repository: proposals, decisionSink: createApprovalDecisionSink(jobs, outbox) })
  const oidc = new OidcService({
    repository: identity,
    config: {
      issuer: required('COMMERCE_OIDC_ISSUER'),
      audience: required('COMMERCE_OIDC_AUDIENCE'),
      clientId: required('COMMERCE_OIDC_CLIENT_ID'),
      authorizationEndpoint: required('COMMERCE_OIDC_AUTHORIZATION_ENDPOINT'),
      tokenEndpoint: required('COMMERCE_OIDC_TOKEN_ENDPOINT'),
      jwksUri: required('COMMERCE_OIDC_JWKS_URI'),
      redirectUri: required('COMMERCE_OIDC_REDIRECT_URI'),
    },
  })
  const resources = new ScopedResources({ store, investigations, reports, evidence, proposals })
  const requiredWorkerKinds = (process.env.COMMERCE_REQUIRED_WORKERS ?? '').split(',').map(value => value.trim()).filter(Boolean)
  const api = new CommerceApi({
    identity, oidc, investigations, approvals, resources,
    idempotency: new RequestIdempotency(store.database),
    allowedOrigins: required('COMMERCE_ALLOWED_ORIGINS').split(',').map(value => value.trim()).filter(Boolean),
    asOf: required('COMMERCE_AS_OF'), fixtureDigest: required('COMMERCE_DATA_DIGEST'), budget: DEFAULT_BUDGET,
    taskSink: createTaskJobSink(jobs, outbox),
    feedback: new FeedbackService(store), monitoring: new MonitorRepository(store),
    health: new HealthService(store, { requiredWorkerKinds }), metrics: new CommerceMetrics(store),
  })
  return { api, store }
}

if (import.meta.main) {
  const { api, store } = createApiFromEnvironment()
  const port = Number(process.env.COMMERCE_API_PORT ?? 3210)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('COMMERCE_API_PORT must be an integer from 1 to 65535')
  const hostname = process.env.COMMERCE_API_HOST ?? '127.0.0.1'
  const server = Bun.serve({ port, hostname, fetch: request => api.fetch(request) })
  let shuttingDown = false
  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    console.error(JSON.stringify({ level: 'info', event: 'shutdown', signal }))
    await server.stop(false)
    store.close()
  }
  process.once('SIGTERM', () => void shutdown('SIGTERM'))
  process.once('SIGINT', () => void shutdown('SIGINT'))
  console.error(`Commerce API listening on ${hostname}:${port}`)
}
