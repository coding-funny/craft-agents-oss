import { describe, expect, test } from 'bun:test'
import { CommerceDatabase } from '../../src/storage/database.ts'
import { HealthService, WorkerHeartbeatRepository } from '../../src/health/health-service.ts'
import { CommerceMetrics } from '../../src/observability/metrics.ts'
import { redactForLog } from '../../src/observability/redaction.ts'

describe('health and observability', () => {
  test('readiness requires fresh heartbeats for configured workers', () => {
    const store = new CommerceDatabase(':memory:'); const now = new Date('2026-09-18T01:00:00.000Z')
    const health = new HealthService(store, { requiredWorkerKinds: ['INVESTIGATE'], workerStaleMs: 60_000, now: () => now })
    expect(health.liveness().status).toBe('UP')
    expect(health.readiness().status).toBe('NOT_READY')
    new WorkerHeartbeatRepository(store).beat({ workerId: 'worker-1', workerKind: 'INVESTIGATE', startedAt: now.toISOString(), now: now.toISOString(), buildVersion: 'test' })
    expect(health.readiness().status).toBe('READY')
    store.close()
  })

  test('metrics stay aggregate and telemetry redacts credentials', () => {
    const store = new CommerceDatabase(':memory:'); const metrics = new CommerceMetrics(store).render()
    expect(metrics).toContain('commerce_jobs_ready')
    expect(metrics).not.toContain('tenant_id=')
    expect(redactForLog({ authorization: 'Bearer abc', nested: { password: 'secret', note: 'Bearer xyz' } })).toEqual({ authorization: '[REDACTED]', nested: { password: '[REDACTED]', note: 'Bearer [REDACTED]' } })
    store.close()
  })
})
