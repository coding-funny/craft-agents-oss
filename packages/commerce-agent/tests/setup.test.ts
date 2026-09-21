import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { validatePermissionsContent, validateSourceConfig } from '@craft-agent/shared/config'
import { loadSource } from '@craft-agent/shared/sources'
import { loadSkill } from '@craft-agent/shared/skills'
import { runCommerceSetup } from '../src/setup/setup-check.ts'
import { AGENT_TOOL_PATTERN } from '../src/setup/source-template.ts'

const temporaryDirectories: string[] = []

function tempWorkspace(): string {
  const path = mkdtempSync(resolve(tmpdir(), 'commerce-setup-'))
  temporaryDirectories.push(path)
  return path
}

function setupOptions(workspaceRoot: string) {
  return {
    workspaceRoot,
    repoRoot: resolve(import.meta.dir, '../../..'),
    bunPath: process.execPath,
  }
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('commerce Source setup', () => {
  it('keeps dry-run read-only and reports planned files', () => {
    const workspace = tempWorkspace()
    const result = runCommerceSetup(setupOptions(workspace), 'dry-run')
    expect(result.actions).toHaveLength(7)
    expect(result.actions.every(action => action.action === 'create')).toBe(true)
    expect(loadSource(workspace, 'commerce')).toBeNull()
  })

  it('installs a host-recognized stdio Source and is idempotent', () => {
    const workspace = tempWorkspace()
    const first = runCommerceSetup(setupOptions(workspace), 'apply')
    const second = runCommerceSetup(setupOptions(workspace), 'apply')
    expect(first.actions.every(action => action.action === 'create')).toBe(true)
    expect(second.actions.every(action => action.action === 'unchanged')).toBe(true)

    const source = loadSource(workspace, 'commerce')
    expect(source?.config.type).toBe('mcp')
    expect(source?.config.mcp?.transport).toBe('stdio')
    expect(validateSourceConfig(source?.config).valid).toBe(true)
    const skill = loadSkill(workspace, 'commerce-diagnosis')
    expect(skill?.metadata.requiredSources).toEqual(['commerce'])
    expect(skill?.content).toContain('validate_report')
  })

  it('installs valid permissions without operator approval or execution tools', () => {
    const workspace = tempWorkspace()
    runCommerceSetup(setupOptions(workspace), 'apply')
    const permissionsPath = resolve(workspace, 'sources/commerce/permissions.json')
    const permissions = readFileSync(permissionsPath, 'utf8')
    expect(validatePermissionsContent(permissions).valid).toBe(true)
    const parsed = JSON.parse(permissions) as { allowedMcpPatterns: string[] }
    expect(parsed.allowedMcpPatterns).toEqual([AGENT_TOOL_PATTERN])
    const hostScoped = new RegExp(`mcp__commerce__.*${parsed.allowedMcpPatterns[0]}`)
    expect(hostScoped.test('mcp__commerce__query_sales')).toBe(true)
    expect(hostScoped.test('mcp__commerce__validate_report')).toBe(true)
    expect(hostScoped.test('mcp__commerce__create_proposal')).toBe(true)
    expect(hostScoped.test('mcp__commerce__execute_action')).toBe(false)
    expect(hostScoped.test('mcp__other__query_sales')).toBe(false)
  })

  it('refuses to overwrite an existing conflicting Source file', () => {
    const workspace = tempWorkspace()
    runCommerceSetup(setupOptions(workspace), 'apply')
    const guidePath = resolve(workspace, 'sources/commerce/guide.md')
    writeFileSync(guidePath, '# user-owned guide\n')
    expect(() => runCommerceSetup(setupOptions(workspace), 'apply')).toThrow('Refusing to overwrite')
  })
})
