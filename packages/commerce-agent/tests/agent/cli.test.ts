import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { CommerceDatabase } from '../../src/storage/database.ts'
import { InvestigationRepository } from '../../src/storage/investigation-repository.ts'
import { TEST_BUDGET, TEST_PRINCIPAL } from './helpers.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('T33-T35 investigation CLI', () => {
  it('emits one JSON result and continues WAITING_INPUT with optimistic task versions', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'commerce-cli-'))
    roots.push(root)
    const inputPath = resolve(root, 'input.json')
    const configPath = resolve(root, 'config.json')
    const scriptPath = resolve(root, 'script.json')
    const dbPath = resolve(root, 'runtime.sqlite')
    writeFileSync(inputPath, JSON.stringify({ schemaVersion: 1, question: 'What changed?' }))
    writeFileSync(scriptPath, JSON.stringify([{ error: 'must not be called' }]))
    writeFileSync(configPath, JSON.stringify({
      schemaVersion: 1, dataMode: 'fixture', model: { mode: 'fake', scriptPath }, principal: TEST_PRINCIPAL,
      fixtureDir: resolve(import.meta.dir, '../../fixtures'), dbPath,
      reportDir: resolve(root, 'reports'), asOf: '2026-09-15T09:00:00+08:00', budget: TEST_BUDGET,
    }))
    const cli = resolve(import.meta.dir, '../../src/cli/investigate.ts')
    const child = Bun.spawn([process.execPath, 'run', cli, '--input', inputPath, '--config', configPath], {
      stdout: 'pipe', stderr: 'pipe',
    })
    const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()])
    expect(code).toBe(2)
    const lines = stdout.trim().split('\n')
    expect(lines).toHaveLength(1)
    const first = JSON.parse(lines[0]!)
    expect(first.status).toBe('WAITING_INPUT')

    const answersPath = resolve(root, 'answers.json')
    writeFileSync(answersPath, JSON.stringify({ expectedTaskVersion: 1, scope: { shopId: 'demo-shop' } }))
    const continued = Bun.spawn([
      process.execPath, 'run', cli, '--continue-task', first.taskId, '--answers', answersPath, '--config', configPath,
    ], { stdout: 'pipe', stderr: 'pipe' })
    const [continuedCode, continuedStdout] = await Promise.all([continued.exited, new Response(continued.stdout).text()])
    expect(continuedCode).toBe(2)
    const second = JSON.parse(continuedStdout.trim())
    expect(second.status).toBe('WAITING_INPUT')
    expect(second.runId).not.toBe(first.runId)

    const store = new CommerceDatabase(dbPath)
    try {
      const repository = new InvestigationRepository(store)
      expect((await repository.getTask(first.taskId)).version).toBe(2)
      const secondRun = await repository.getRun(second.runId)
      expect(secondRun.parentRunId).toBe(first.runId)
      expect(secondRun.taskVersion).toBe(2)
    } finally { store.close() }

    writeFileSync(answersPath, JSON.stringify({ expectedTaskVersion: 1, scope: { skuIds: ['SKU-A'] } }))
    const stale = Bun.spawn([
      process.execPath, 'run', cli, '--continue-task', first.taskId, '--answers', answersPath, '--config', configPath,
    ], { stdout: 'pipe', stderr: 'pipe' })
    const [staleCode, staleStdout] = await Promise.all([stale.exited, new Response(stale.stdout).text()])
    expect(staleCode).toBe(1)
    expect(JSON.parse(staleStdout.trim()).error.message).toContain('stale task version')
  })
})
