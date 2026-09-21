import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { CaseRepository } from '../src/recovery/case-repository.ts'
import { runRecoverableCase } from '../src/recovery/runner.ts'
import { CommerceDatabase } from '../src/storage/database.ts'

const temporaryDirectories: string[] = []
const fixtureDir = resolve(import.meta.dir, '../fixtures')

function root(): string {
  const path = mkdtempSync(resolve(tmpdir(), 'commerce-recovery-'))
  temporaryDirectories.push(path)
  return path
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('recoverable case runner', () => {
  it('resumes after a report interruption and does not repeat the side effect', async () => {
    const runtimeRoot = root()
    const first = await runRecoverableCase({
      rootDir: runtimeRoot,
      fixtureDir,
      sessionId: 'session-recovery-001',
      caseName: 'ads-conversion',
      stopAfter: 'REPORT_READY',
    })
    expect(first.status).toBe('REPORT_READY')
    expect(first.reportId).toMatch(/^report_/)

    const resumed = await runRecoverableCase({
      rootDir: runtimeRoot,
      fixtureDir,
      sessionId: 'session-recovery-001',
      caseName: 'ads-conversion',
      autoApprove: true,
    })
    expect(resumed.status).toBe('SUCCEEDED')
    expect(resumed.parentTraceId).toBe(first.traceId)

    const replay = await runRecoverableCase({
      rootDir: runtimeRoot,
      fixtureDir,
      sessionId: 'session-recovery-001',
      caseName: 'ads-conversion',
      autoApprove: true,
    })
    expect(replay.status).toBe('SUCCEEDED')
    expect(replay.proposalId).toBe(resumed.proposalId)
    expect(replay.replayed).toBe(true)

    const store = new CommerceDatabase(resolve(runtimeRoot, 'commerce.sqlite'))
    const operations = store.database.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM mock_operations').get()
    expect(operations?.count).toBe(1)
    expect(new CaseRepository(store).listEvents('session-recovery-001').length).toBeGreaterThan(8)
    store.close()
  })

  it('resumes UNKNOWN by reconciliation without issuing another write', async () => {
    const runtimeRoot = root()
    const unknown = await runRecoverableCase({
      rootDir: runtimeRoot,
      fixtureDir,
      sessionId: 'session-recovery-unknown',
      caseName: 'ads-conversion',
      autoApprove: true,
      simulateResponseLoss: true,
      stopAfter: 'EXECUTION_UNKNOWN',
    })
    expect(unknown.status).toBe('UNKNOWN')

    const recovered = await runRecoverableCase({
      rootDir: runtimeRoot,
      fixtureDir,
      sessionId: 'session-recovery-unknown',
      caseName: 'ads-conversion',
      autoApprove: true,
      reconcileUnknown: true,
    })
    expect(recovered.status).toBe('SUCCEEDED')
    const store = new CommerceDatabase(resolve(runtimeRoot, 'commerce.sqlite'))
    const operations = store.database.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM mock_operations').get()
    expect(operations?.count).toBe(1)
    store.close()
  })

  it('treats a validated NEEDS_DATA report as a completed diagnostic terminal', async () => {
    const completed = await runRecoverableCase({
      rootDir: root(),
      fixtureDir,
      sessionId: 'session-needs-data',
      caseName: 'inventory-shortage',
      autoApprove: true,
    })
    expect(completed.status).toBe('REPORT_READY')
    expect(completed.proposalId).toBeUndefined()
    expect(completed.completionReason).toContain('NEEDS_DATA')
  })

  it('persists an explicit timeout instead of reporting an early message as completion', async () => {
    const runtimeRoot = root()
    await expect(runRecoverableCase({
      rootDir: runtimeRoot,
      fixtureDir,
      sessionId: 'session-timeout',
      caseName: 'ads-conversion',
      timeoutMs: 0,
    })).rejects.toThrow('exceeded 0ms')
    const store = new CommerceDatabase(resolve(runtimeRoot, 'commerce.sqlite'))
    expect(new CaseRepository(store).getOrThrow('session-timeout').state).toBe('TIMED_OUT')
    store.close()
  })
})
