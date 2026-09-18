import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { runDemo } from '../demo/run-demo.ts'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('one-click commerce demo', () => {
  it('can run twice on one runtime without duplicating the side effect', async () => {
    const runtimeRoot = mkdtempSync(resolve(tmpdir(), 'commerce-demo-'))
    temporaryDirectories.push(runtimeRoot)
    const first = await runDemo({ runtimeRoot, mcpSmoke: false })
    const second = await runDemo({ runtimeRoot, mcpSmoke: false })
    expect(first.firstRun.status).toBe('SUCCEEDED')
    expect(first.operationCount).toBe(1)
    expect(second.operationCount).toBe(1)
    expect(second.firstRun.proposalId).toBe(first.firstRun.proposalId)
    expect(second.replayRun.replayed).toBe(true)
    expect(second.sourceSetup.unchanged).toBe(7)
  })
})
