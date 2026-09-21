import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CommerceDatabase } from '../../src/storage/database.ts'
import { createAndVerifySqliteBackup } from '../../src/operations/sqlite-backup.ts'
import { evaluateRelease } from '../../src/release/release-gate.ts'

const manifest = { schemaVersion: 1, environment: 'pilot', commit: 'abcdef0', imageDigest: `sha256:${'a'.repeat(64)}`, schemaVersions: ['0001'], versions: { model: 'm1', prompt: 'p1', tool: 't1', policy: 'a1' }, evaluation: { decision: 'PASS', evidenceMode: 'live', datasetDigest: 'data1', reviewComplete: true }, tests: { commercePassed: true, webuiBuildPassed: true, postgresVerified: true, browserE2ePassed: true, telemetryVerified: true, workerRuntimeVerified: true, backupRestoreVerified: true, soakHours: 24 }, createdAt: '2026-09-18T00:00:00.000Z' }

describe('release and recovery gates', () => {
  test('requires all pilot evidence and 24 hour soak', () => {
    expect(evaluateRelease(manifest).decision).toBe('PASS')
    const result = evaluateRelease({ ...manifest, tests: { ...manifest.tests, soakHours: 2 } })
    expect(result).toEqual({ decision: 'BLOCKED', reasons: ['SOAK_24H_NOT_VERIFIED'] })
  })

  test('creates a separate SQLite backup and verifies critical tables', () => {
    const directory = mkdtempSync(join(tmpdir(), 'commerce-backup-')); const sourcePath = join(directory, 'source.sqlite')
    const store = new CommerceDatabase(sourcePath); store.close()
    const result = createAndVerifySqliteBackup({ environment: 'fixture', sourcePath, backupDirectory: join(directory, 'backups'), confirmation: 'VERIFY_NON_PRODUCTION_BACKUP' })
    expect(result.integrity).toBe('ok')
    expect(result.backupPath).not.toBe(sourcePath)
    expect(result.tables.commerce_jobs?.count).toBe(0)
  })
})
